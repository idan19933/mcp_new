/**
 * Clarity PPM HTTP Server v4.0.0 - Enhanced Intelligent Describe Edition
 * - Uses /describe and /describeAttributes for dynamic schema discovery
 * - Supports multiple filter combinations for different object types
 * - Intelligent caching and query optimization
 */

import express, { Request, Response } from 'express';

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

// ============================================================================
// CONFIGURATION
// ============================================================================

interface ClarityConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  sessionId?: string;
  authToken?: string;
}

const config: ClarityConfig = {
  baseUrl: process.env.CLARITY_BASE_URL || 'http://localhost:8080',
  username: process.env.CLARITY_USERNAME,
  password: process.env.CLARITY_PASSWORD,
  sessionId: process.env.CLARITY_SESSION_ID,
  authToken: process.env.CLARITY_AUTH_TOKEN,
};

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================================================
// HTTP CLIENT
// ============================================================================

async function makeRequest(urlPath: string, method: string = 'GET', body?: any): Promise<any> {
  const cleanPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  const fullUrl = `${config.baseUrl}/ppm/rest/v1${cleanPath}`;

  console.log(`[Clarity API] ${method} ${fullUrl}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  if (config.username && config.password) {
    headers['Authorization'] = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  } else if (config.sessionId) {
    headers['Cookie'] = config.sessionId;
  } else if (config.authToken) {
    headers['Authorization'] = `Bearer ${config.authToken}`;
  }

  const options: RequestInit = { method, headers };
  if (body && method !== 'GET') options.body = JSON.stringify(body);

  try {
    const response = await fetch(fullUrl, options);
    
    if (!response.ok) {
      if (response.status === 404) return { _results: [], _error: "Not Found", _status: 404 };
      
      const errorText = await response.text();
      throw new Error(`API Error ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : { success: true };
  } catch (error) {
    console.error(`[API Fail] ${fullUrl}:`, error);
    throw error;
  }
}

// ============================================================================
// INTELLIGENT METADATA CACHE
// ============================================================================

interface ObjectMetadata {
  resourceName: string;
  objectCode: string;
  supportedHttpMethods: string[];
  childResources: string[];
  attributes: AttributeMetadata[];
  isCustom: boolean;
  hierarchyEnabled: boolean;
  lastUpdated: number;
}

interface AttributeMetadata {
  apiName: string;
  dataType: string;
  displayName: string;
  required: boolean;
  isLookup: boolean;
  lookupType?: string;
  lookupValues?: Array<{ code: string; displayValue: string }>;  // Added for lookup resolution
  maxLength?: number;
  isCustom: boolean;
  actionType?: string;  // Added to track filter-only fields
}

const metadataCache = new Map<string, ObjectMetadata>();
const CACHE_TTL = 1000 * 60 * 15; // 15 minutes

// Cache for discovered objects
let discoveredObjects: string[] | null = null;
let discoveredObjectsTimestamp = 0;

/**
 * Discovers all available objects (standard + custom) from Clarity PPM
 */
async function discoverAllObjects(): Promise<string[]> {
  const now = Date.now();
  
  // Return cached if still valid
  if (discoveredObjects && (now - discoveredObjectsTimestamp) < CACHE_TTL) {
    return discoveredObjects;
  }
  
  try {
    console.log('[Discovery] Fetching all objects from /describe...');
    
    // Get all objects (standard + custom)
    const allObjectsUrl = '/describe?limit=500';
    const allObjects = await makeRequest(allObjectsUrl, 'GET');
    
    // Get custom objects specifically
    const customObjectsUrl = '/describe?filter=(isCustom = true) and (isSystem = false)&limit=500';
    const customObjects = await makeRequest(customObjectsUrl, 'GET');
    
    const objectNames = new Set<string>();
    
    // Add all standard objects
    if (allObjects._results) {
      allObjects._results.forEach((obj: any) => {
        if (obj.resourceName) {
          objectNames.add(obj.resourceName);
        }
      });
    }
    
    // Ensure custom objects are included
    if (customObjects._results) {
      customObjects._results.forEach((obj: any) => {
        if (obj.resourceName) {
          objectNames.add(obj.resourceName);
        }
      });
    }
    
    discoveredObjects = Array.from(objectNames);
    discoveredObjectsTimestamp = now;
    
    console.log(`[Discovery] Found ${discoveredObjects.length} objects (including ${customObjects._totalCount || 0} custom)`);
    
    return discoveredObjects;
  } catch (error) {
    console.error('[Discovery] Failed to discover objects:', error);
    
    // Fallback to known standard objects
    discoveredObjects = [
      'projects', 'tasks', 'resources', 'teams', 'ideas', 'risks', 'issues',
      'timesheets', 'timeEntries', 'allocations', 'assignments', 'investments',
      'portfolios', 'programs', 'milestones', 'dependencies', 'workProducts'
    ];
    
    return discoveredObjects;
  }
}

/**
 * Resolves a human-readable lookup value to its API code
 * E.g., "Completed" -> "C", "Active" -> "A"
 */
function resolveLookupValue(metadata: ObjectMetadata, fieldName: string, displayValue: string): string {
  const attribute = metadata.attributes.find(attr => attr.apiName === fieldName);
  
  if (!attribute || !attribute.isLookup) {
    console.log(`[LookupResolver] ${fieldName} is not a lookup field`);
    return displayValue; // Not a lookup field
  }
  
  if (!attribute.lookupValues || attribute.lookupValues.length === 0) {
    console.warn(`[LookupResolver] No lookup values available for ${fieldName}. Metadata might not include them.`);
    return displayValue; // No values available
  }
  
  console.log(`[LookupResolver] Available values for ${fieldName}:`, 
    JSON.stringify(attribute.lookupValues.map(lv => ({ code: lv.code, display: lv.displayValue })), null, 2));
  
  // Try exact match first (case-insensitive)
  const lowerDisplay = displayValue.toLowerCase();
  const exactMatch = attribute.lookupValues.find(lv => 
    lv.displayValue?.toLowerCase() === lowerDisplay
  );
  
  if (exactMatch) {
    console.log(`[LookupResolver] ✓ Resolved '${displayValue}' -> '${exactMatch.code}' for ${fieldName}`);
    return exactMatch.code;
  }
  
  // Try partial match
  const partialMatch = attribute.lookupValues.find(lv =>
    lv.displayValue?.toLowerCase().includes(lowerDisplay) ||
    lowerDisplay.includes(lv.displayValue?.toLowerCase() || '')
  );
  
  if (partialMatch) {
    console.log(`[LookupResolver] ✓ Resolved '${displayValue}' -> '${partialMatch.code}' for ${fieldName} (partial match)`);
    return partialMatch.code;
  }
  
  // Check if it's already a code
  const codeMatch = attribute.lookupValues.find(lv => lv.code === displayValue);
  if (codeMatch) {
    console.log(`[LookupResolver] ✓ '${displayValue}' is already a valid code for ${fieldName}`);
    return displayValue;
  }
  
  console.warn(`[LookupResolver] ✗ Could not resolve '${displayValue}' for ${fieldName}`);
  console.warn(`[LookupResolver] Available: ${attribute.lookupValues.map(lv => `${lv.code}=${lv.displayValue}`).join(', ')}`);
  
  return displayValue; // Return as-is if no match
}

// ============================================================================
// METADATA DISCOVERY - Using /describe and /describeAttributes
// ============================================================================

/**
 * Discovers all available objects in Clarity
 * Pattern: /describe?filter=((extensions in ('inv')) and (isCustom = true) and (capabilities in ('HIERARCHY_ENABLED')))
 */
async function discoverAllObjects(): Promise<string[]> {
  console.log('[Metadata] Discovering all objects...');
  
  try {
    // Get standard objects
    const standardResult = await makeRequest('/describe?limit=500');
    
    // Get custom objects
    const customResult = await makeRequest('/describe?filter=((isCustom = true))&limit=500');
    
    const allObjects = [
      ...(standardResult._results || []),
      ...(customResult._results || [])
    ];
    
    const objectNames = allObjects
      .map((obj: any) => obj.resourceName)
      .filter(Boolean);
    
    console.log(`[Metadata] Discovered ${objectNames.length} objects`);
    return objectNames;
    
  } catch (error) {
    console.error('[Metadata] Discovery failed:', error);
    return [
      'projects', 'tasks', 'resources', 'timesheets', 'ideas', 'risks', 
      'issues', 'objectives', 'roadmaps', 'users', 'agreements'
    ]; // Fallback
  }
}

/**
 * Detects the appropriate filter pattern based on object type
 */
function detectObjectFilterPattern(objectName: string): 'full' | 'simple' {
  const lowerName = objectName.toLowerCase();
  
  // OBA objects always use simple pattern
  if (lowerName.startsWith('oba')) {
    return 'simple';
  }
  
  // Standard objects use full pattern
  const standardObjects = [
    'projects', 'tasks', 'resources', 'timesheets', 'ideas', 'risks', 
    'issues', 'users', 'allocations', 'agreements'
  ];
  
  if (standardObjects.includes(lowerName)) {
    return 'full';
  }
  
  // Custom objects: try full first, can fall back to simple
  return 'full';
}

/**
 * Gets comprehensive metadata for a specific object
 * Supports multiple filter combinations:
 * - Full: honorFieldLevelSecurity + dataType filter + includeObjFilters + actionType
 * - Simple: honorFieldLevelSecurity only
 */
async function getObjectMetadata(objectName: string, forceRefresh: boolean = false): Promise<ObjectMetadata> {
  const cacheKey = objectName.toLowerCase();
  
  // Check cache
  if (!forceRefresh && metadataCache.has(cacheKey)) {
    const cached = metadataCache.get(cacheKey)!;
    if (Date.now() - cached.lastUpdated < CACHE_TTL) {
      console.log(`[Metadata] Using cached metadata for ${objectName}`);
      return cached;
    }
  }
  
  console.log(`[Metadata] Fetching metadata for ${objectName}...`);
  
  try {
    // Step 1: Get object-level metadata
    const describeResult = await makeRequest(
      `/describe/${objectName}?filter=(excludeAttributes = false)`
    );
    
    // Step 2: Detect filter pattern
    const filterPattern = detectObjectFilterPattern(objectName);
    
    // Step 3: Build describeAttributes query
    let attributesUrl: string;
    
    if (filterPattern === 'full') {
      // Full filter pattern for standard and complex custom objects
      // Pattern: (resourceName='X') and (honorFieldLevelSecurity=true) and 
      //          (dataType notIn ('clob','attachment')) and (includeObjFilters=true) and 
      //          (actionType!='dataOnly')
      attributesUrl = `/describeAttributes?filter=((resourceName = '${objectName}') and (honorFieldLevelSecurity = true) and (dataType notIn ('clob','attachment')) and (includeObjFilters = true) and (actionType != 'dataOnly'))&limit=1500&_totalCount=false`;
    } else {
      // Simple filter pattern for OBA and simple custom objects
      // Pattern: (resourceName='X') and (honorFieldLevelSecurity=true)
      attributesUrl = `/describeAttributes?filter=((resourceName = '${objectName}') and (honorFieldLevelSecurity = true))&limit=1500&_totalCount=false`;
    }
    
    console.log(`[Metadata] Using ${filterPattern} filter pattern`);
    
    let attributesResult;
    try {
      attributesResult = await makeRequest(attributesUrl);
    } catch (error) {
      // If full pattern fails, try simple pattern
      if (filterPattern === 'full') {
        console.log(`[Metadata] Full pattern failed, trying simple pattern...`);
        attributesUrl = `/describeAttributes?filter=((resourceName = '${objectName}') and (honorFieldLevelSecurity = true))&limit=1500&_totalCount=false`;
        attributesResult = await makeRequest(attributesUrl);
      } else {
        throw error;
      }
    }
    
    // Process attributes
    const attributes: AttributeMetadata[] = (attributesResult._results || []).map((attr: any) => ({
      apiName: attr.apiName || attr.name,
      dataType: attr.dataType || 'string',
      displayName: attr.displayName || attr.apiName || attr.name,
      required: attr.required === true,
      isLookup: attr.dataType === 'lookup',
      lookupType: attr.lookupType,
      lookupValues: attr.lookupValues || attr.validValues || [],  // Capture lookup values
      maxLength: attr.maxLength,
      isCustom: attr.isCustom === true,
      actionType: attr.actionType  // Capture if field is filterOnly/dataOnly
    }));
    
    // Build metadata object
    const metadata: ObjectMetadata = {
      resourceName: objectName,
      objectCode: describeResult.objectCode || objectName,
      supportedHttpMethods: describeResult.supportedHttpMethods || ['GET'],
      childResources: describeResult.childResources || [],
      attributes,
      isCustom: describeResult.isCustom === true,
      hierarchyEnabled: describeResult.hierarchyEnabled === true,
      lastUpdated: Date.now()
    };
    
    // Cache it
    metadataCache.set(cacheKey, metadata);
    console.log(`[Metadata] Cached ${attributes.length} attributes for ${objectName}`);
    
    return metadata;
    
  } catch (error) {
    console.error(`[Metadata] Failed to fetch metadata for ${objectName}:`, error);
    throw error;
  }
}

/**
 * Gets smart field selection based on metadata
 * Filters out CLOB, attachment, and filter-only field types
 */
function getSmartFieldSelection(metadata: ObjectMetadata, maxFields: number = 15): string[] {
  const priorityFields = ['_internalId', 'name', 'code', 'uniqueName', 'status'];
  
  const filteredAttributes = metadata.attributes
    .filter(attr => {
      // Exclude problematic types
      if (attr.dataType === 'clob' || attr.dataType === 'attachment') return false;
      if (attr.apiName === 'attachment') return false;
      
      // Exclude filter-only fields (actionType = 'filterOnly' or 'dataOnly')
      if (attr.actionType === 'filterOnly' || attr.actionType === 'dataOnly') return false;
      
      // Include priority fields
      if (priorityFields.includes(attr.apiName)) return true;
      
      // Include reasonable fields
      return attr.apiName !== '_links' && 
             (!attr.apiName.startsWith('_') || attr.apiName === '_internalId');
    })
    .sort((a, b) => {
      // Sort by priority
      const aPriority = priorityFields.indexOf(a.apiName);
      const bPriority = priorityFields.indexOf(b.apiName);
      if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
      if (aPriority !== -1) return -1;
      if (bPriority !== -1) return 1;
      return a.apiName.localeCompare(b.apiName);
    })
    .slice(0, maxFields);
  
  return filteredAttributes.map(attr => attr.apiName);
}

// ============================================================================
// INTELLIGENT QUERY BUILDER
// ============================================================================

interface QueryIntent {
  operation: 'count' | 'list' | 'get' | 'create' | 'update' | 'delete';
  objectType: string;
  filters?: Record<string, any>;
  fields?: string[];
  parentId?: string;
  childType?: string;
  limit?: number;
  recordId?: number | string;  // For update/delete operations
  data?: Record<string, any>;  // For create/update operations
}

async function buildIntelligentQuery(intent: QueryIntent, previousResults?: any[]): Promise<any> {
  console.log('[QueryBuilder] Building query for:', JSON.stringify(intent, null, 2));
  
  // Get metadata
  const metadata = await getObjectMetadata(intent.objectType);
  
  // Build query/request based on operation
  let path = `/${intent.objectType}`;
  let method = 'GET';
  let query: Record<string, string | number> = {};
  let body: any = null;
  
  // Handle UPDATE operation
  if (intent.operation === 'update' && intent.recordId) {
    let actualRecordId = intent.recordId;
    
    // Check if recordId is a reference to previous step
    if (typeof actualRecordId === 'string' && actualRecordId.includes('STEP_')) {
      const stepMatch = actualRecordId.match(/STEP_(\d+)_ID/);
      if (stepMatch && previousResults) {
        const stepIndex = parseInt(stepMatch[1]) - 1;
        const previousResult = previousResults[stepIndex];
        
        // Extract ID from previous result
        if (previousResult?.result?._internalId) {
          // Single record created/updated
          actualRecordId = previousResult.result._internalId;
          console.log(`[QueryBuilder] Resolved ${intent.recordId} to ${actualRecordId}`);
        } else if (previousResult?.result?._results?.[0]?._internalId) {
          // List result - get first record
          actualRecordId = previousResult.result._results[0]._internalId;
          console.log(`[QueryBuilder] Resolved ${intent.recordId} to ${actualRecordId}`);
        }
      }
    }
    
    // Handle parent-child UPDATE (e.g., update task in project)
    if (intent.parentId && intent.childType) {
      let actualParentId = intent.parentId;
      if (typeof actualParentId === 'string' && actualParentId.includes('STEP_')) {
        const stepMatch = actualParentId.match(/STEP_(\d+)_ID/);
        if (stepMatch && previousResults) {
          const stepIndex = parseInt(stepMatch[1]) - 1;
          const previousResult = previousResults[stepIndex];
          if (previousResult?.result?._results?.[0]?._internalId) {
            actualParentId = previousResult.result._results[0]._internalId;
            console.log(`[QueryBuilder] Resolved ${intent.parentId} to ${actualParentId}`);
          }
        }
      }
      path = `/${intent.objectType}/${actualParentId}/${intent.childType}/${actualRecordId}`;
      
      // Get child metadata for lookup resolution
      const childMetadata = await getObjectMetadata(intent.childType);
      metadata.attributes = childMetadata.attributes;
    } else {
      path = `/${intent.objectType}/${actualRecordId}`;
    }
    
    // Resolve lookup values in data
    body = intent.data || {};
    if (body && typeof body === 'object') {
      const resolvedBody: Record<string, any> = {};
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') {
          resolvedBody[key] = resolveLookupValue(metadata, key, value);
        } else {
          resolvedBody[key] = value;
        }
      }
      
      // Apply business logic based on status changes
      if (resolvedBody.status && intent.childType === 'tasks') {
        const statusValue = String(resolvedBody.status).toLowerCase();
        
        // If setting to completed/complete/closed, also set percentComplete to 100
        if (statusValue.includes('complet') || statusValue.includes('close') || 
            statusValue === 'c' || statusValue === 'co') {
          if (!resolvedBody.percentComplete) {
            resolvedBody.percentComplete = 100;
            console.log('[BusinessLogic] Auto-set percentComplete=100 for completed status');
          }
        }
        
        // If setting to planning/not started, set percentComplete to 0
        if (statusValue.includes('plan') || statusValue.includes('not') || 
            statusValue === 'p' || statusValue === 'ns') {
          if (!resolvedBody.percentComplete) {
            resolvedBody.percentComplete = 0;
            console.log('[BusinessLogic] Auto-set percentComplete=0 for planning status');
          }
        }
      }
      
      body = resolvedBody;
    }
    
    method = 'PATCH';
    return { path, query: {}, metadata, method, body };
  }
  
  // Handle CREATE operation
  if (intent.operation === 'create') {
    method = 'POST';
    body = intent.data || {};
    
    // Handle parent-child create (e.g., create task in project)
    if (intent.parentId && intent.childType) {
      let actualParentId = intent.parentId;
      if (typeof actualParentId === 'string' && actualParentId.includes('STEP_')) {
        const stepMatch = actualParentId.match(/STEP_(\d+)_ID/);
        if (stepMatch && previousResults) {
          const stepIndex = parseInt(stepMatch[1]) - 1;
          const previousResult = previousResults[stepIndex];
          if (previousResult?.result?._results?.[0]?._internalId) {
            actualParentId = previousResult.result._results[0]._internalId;
            console.log(`[QueryBuilder] Resolved ${intent.parentId} to ${actualParentId}`);
          }
        }
      }
      path = `/${intent.objectType}/${actualParentId}/${intent.childType}`;
      
      // Get child metadata for lookup resolution
      const childMetadata = await getObjectMetadata(intent.childType);
      metadata.attributes = childMetadata.attributes;
    }
    
    // Resolve lookup values in data
    if (body && typeof body === 'object') {
      const resolvedBody: Record<string, any> = {};
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') {
          resolvedBody[key] = resolveLookupValue(metadata, key, value);
        } else {
          resolvedBody[key] = value;
        }
      }
      
      // Apply business logic based on status
      if (resolvedBody.status && intent.childType === 'tasks') {
        const statusValue = String(resolvedBody.status).toLowerCase();
        
        // If creating as completed, set percentComplete to 100
        if (statusValue.includes('complet') || statusValue.includes('close') || 
            statusValue === 'c' || statusValue === 'co') {
          if (!resolvedBody.percentComplete) {
            resolvedBody.percentComplete = 100;
            console.log('[BusinessLogic] Auto-set percentComplete=100 for completed status');
          }
        }
      }
      
      body = resolvedBody;
    }
    
    return { path, query: {}, metadata, method, body };
  }
  
  // Handle parent-child relationships for GET/LIST/COUNT
  if (intent.parentId && intent.childType) {
    // Check if parentId is a reference to previous step
    let actualParentId = intent.parentId;
    if (typeof actualParentId === 'string' && actualParentId.includes('STEP_')) {
      // Extract step number (e.g., "STEP_1_ID" -> step 1)
      const stepMatch = actualParentId.match(/STEP_(\d+)_ID/);
      if (stepMatch && previousResults) {
        const stepIndex = parseInt(stepMatch[1]) - 1;
        const previousResult = previousResults[stepIndex];
        if (previousResult?.result?._results?.[0]?._internalId) {
          actualParentId = previousResult.result._results[0]._internalId;
          console.log(`[QueryBuilder] Resolved ${intent.parentId} to ${actualParentId}`);
        }
      }
    }
    
    path = `/${intent.objectType}/${actualParentId}/${intent.childType}`;
    
    // Get child metadata
    const childMetadata = await getObjectMetadata(intent.childType);
    metadata.attributes = childMetadata.attributes;
  }
  
  // Set fields for GET/LIST operations
  if (intent.operation === 'count') {
    query.fields = '_internalId';
    query.limit = 500;
  } else if (intent.fields && intent.fields.length > 0) {
    // Validate requested fields against metadata
    const validFields = intent.fields.filter(field => {
      const attr = metadata.attributes.find(a => a.apiName === field);
      if (!attr && field !== '_internalId') {
        console.warn(`[FieldValidation] Field '${field}' not found in metadata, excluding`);
        return false;
      }
      return true;
    });
    
    if (validFields.length === 0) {
      // If no valid fields, use smart selection
      const smartFields = getSmartFieldSelection(metadata);
      query.fields = smartFields.join(',');
      console.log(`[FieldValidation] No valid fields requested, using smart selection`);
    } else {
      query.fields = validFields.join(',');
      if (validFields.length < intent.fields.length) {
        console.log(`[FieldValidation] Filtered fields: ${validFields.join(',')} (removed invalid fields)`);
      }
    }
  } else if (intent.operation === 'list' || intent.operation === 'get') {
    const smartFields = getSmartFieldSelection(metadata);
    query.fields = smartFields.join(',');
  }
  
  // Set filters
  if (intent.filters && Object.keys(intent.filters).length > 0) {
    const filterParts: string[] = [];
    
    for (const [key, value] of Object.entries(intent.filters)) {
      if (value === null) {
        filterParts.push(`(${key} = null)`);
      } else if (typeof value === 'boolean') {
        filterParts.push(`(${key} = ${value})`);
      } else if (typeof value === 'number') {
        filterParts.push(`(${key} = ${value})`);
      } else {
        filterParts.push(`(${key} = '${value}')`);
      }
    }
    
    query.filter = filterParts.length === 1 
      ? filterParts[0] 
      : `(${filterParts.join(' and ')})`;
  }
  
  // Set limit (create/update operations already returned above)
  if (intent.limit) {
    query.limit = Math.min(intent.limit, 500);
  } else if (!query.limit) {
    query.limit = intent.operation === 'count' ? 500 : 50;
  }
  
  return { path, query, metadata, method, body };
}

// ============================================================================
// AI AGENT WITH CLAUDE ANALYSIS
// ============================================================================

async function analyzeUserRequest(message: string): Promise<any> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  
  if (!ANTHROPIC_API_KEY) {
    console.log('[AI] No API key, using fallback');
    return fallbackAnalysis(message);
  }

  const systemPrompt = `You are a Clarity PPM API expert that uses intelligent metadata discovery.

**YOUR PROCESS:**
1. Analyze the user's natural language request
2. Identify the Clarity objects involved (projects, tasks, resources, etc.)
3. Determine what operation is needed (count, list, get, create, update)
4. Extract any filters or conditions
5. Return a structured execution plan

**AVAILABLE OPERATIONS:**
- count: Count records (returns total number)
- list: List multiple records with details
- get: Get a single specific record
- create: Create a new record
- update: Update an existing record
- delete: Delete a record

**COMMON CLARITY OBJECTS:**
Standard: projects, tasks, resources, timesheets, ideas, risks, issues
Strategic: objectives, roadmaps, keyResults, roadmapItems
Financial: costPlans, benefitPlans, vouchers, actualTransactions
Custom: custTaskUpdates, custWorkPlanBudget, custMilestoneTracker
OBA: obaTasks, obaInvestments, obaStaffs, obaTodos

**FILTER OPERATORS:**
- = (equals)
- != (not equals)
- > < >= <= (comparisons)
- startsWith, endsWith
- null checks

**EXECUTION PLAN FORMAT:**
{
  "steps": [
    {
      "operation": "count|list|get|create|update|delete",
      "objectType": "projects",
      "filters": { "isActive": true, "status": "APPROVED" },
      "fields": ["name", "code", "manager"],
      "limit": 50
    }
  ],
  "intent": "brief description"
}

**EXAMPLES:**

Q: "How many active projects?"
A: {
  "steps": [
    {
      "operation": "count",
      "objectType": "projects",
      "filters": { "isActive": true }
    }
  ],
  "intent": "count_active_projects"
}

Q: "Show me projects managed by user 5001"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "projects",
      "filters": { "manager": 5001 },
      "fields": ["name", "code", "status", "scheduleStart", "scheduleFinish"],
      "limit": 50
    }
  ],
  "intent": "list_projects_by_manager"
}

Q: "List tasks for project 5003001"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "projects",
      "filters": { "_internalId": 5003001 },
      "childType": "tasks",
      "fields": ["name", "status", "percentComplete", "assignedTo"]
    }
  ],
  "intent": "list_project_tasks"
}

Q: "Show task updates from January"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "custTaskUpdates",
      "filters": { "updateDate": ">= '2025-01-01T00:00:00'" },
      "limit": 50
    }
  ],
  "intent": "list_task_updates"
}

Q: "Show OBA tasks for investment 5003001"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "obaInvestments",
      "filters": { "_internalId": 5003001 },
      "childType": "obaTasks",
      "limit": 100
    }
  ],
  "intent": "list_oba_tasks"
}

Q: "How many tasks in project Alpha"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "projects",
      "filters": { "name": "Alpha" },
      "fields": ["_internalId", "name"]
    },
    {
      "operation": "count",
      "objectType": "projects",
      "parentId": "STEP_1_ID",
      "childType": "tasks"
    }
  ],
  "intent": "count_project_tasks"
}

Q: "Show task status distribution for project this_proj"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "projects",
      "filters": { "code": "this_proj" },
      "fields": ["_internalId", "name"]
    },
    {
      "operation": "list",
      "objectType": "projects",
      "parentId": "STEP_1_ID",
      "childType": "tasks",
      "fields": ["status", "_internalId"],
      "limit": 500
    }
  ],
  "intent": "task_status_distribution"
}

Q: "List tasks in project Alpha"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "projects",
      "filters": { "name": "Alpha" },
      "fields": ["_internalId", "name"]
    },
    {
      "operation": "list",
      "objectType": "projects",
      "parentId": "STEP_1_ID",
      "childType": "tasks",
      "fields": ["name", "status", "percentComplete", "taskOwner", "_internalId"]
    }
  ],
  "intent": "list_project_tasks"
}

Q: "How many tasks in each status for project X"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "projects",
      "filters": { "code": "X" },
      "fields": ["_internalId", "name"]
    },
    {
      "operation": "list",
      "objectType": "projects",
      "parentId": "STEP_1_ID",
      "childType": "tasks",
      "fields": ["status", "_internalId"],
      "limit": 500
    }
  ],
  "intent": "tasks_by_status"
}

Q: "Create a project named NewProject with code NEWPROJ"
A: {
  "steps": [
    {
      "operation": "create",
      "objectType": "projects",
      "data": {
        "name": "NewProject",
        "code": "NEWPROJ"
      }
    }
  ],
  "intent": "create_project"
}

Q: "Create a task called Setup in project Alpha"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "projects",
      "filters": { "name": "Alpha" },
      "fields": ["_internalId", "name"]
    },
    {
      "operation": "create",
      "objectType": "projects",
      "parentId": "STEP_1_ID",
      "childType": "tasks",
      "data": {
        "name": "Setup"
      }
    }
  ],
  "intent": "create_task_in_project"
}

Q: "Create a task named Design with 5 days duration in project Beta"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "projects",
      "filters": { "name": "Beta" },
      "fields": ["_internalId", "name"]
    },
    {
      "operation": "create",
      "objectType": "projects",
      "parentId": "STEP_1_ID",
      "childType": "tasks",
      "data": {
        "name": "Design",
        "durationDays": 5
      }
    }
  ],
  "intent": "create_task_with_duration"
}

Q: "Update project 5003001 to set status as Active"
A: {
  "steps": [
    {
      "operation": "update",
      "objectType": "projects",
      "recordId": 5003001,
      "data": {
        "status": "A"
      }
    }
  ],
  "intent": "update_project_status"
}

Q: "Create a task named Test and set it to 50% complete"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "projects",
      "filters": { "code": "PROJECT_CODE" },
      "fields": ["_internalId"]
    },
    {
      "operation": "create",
      "objectType": "projects",
      "parentId": "STEP_1_ID",
      "childType": "tasks",
      "data": {
        "name": "Test"
      }
    },
    {
      "operation": "update",
      "objectType": "projects",
      "parentId": "STEP_1_ID",
      "childType": "tasks",
      "recordId": "STEP_2_ID",
      "data": {
        "percentComplete": 50
      }
    }
  ],
  "intent": "create_and_update_task"
}

**IMPORTANT RULES:**
1. For "how many X in project Y" - Use TWO steps: find project, then count its children
2. For distributions/grouping - List all items with status field, client will group
3. Use parentId: "STEP_1_ID" to reference previous step results
4. Use recordId: "STEP_X_ID" to update a record from a previous step
5. Always include _internalId in project lookup steps
6. For CREATE operations - Use "data" field with required attributes
7. For UPDATE operations - Use "recordId" and "data" with fields to update
8. For UPDATING TASKS - Include parentId and childType to maintain project context
9. For creating TASKS - Only "name" is required. Optional: durationDays, percentComplete, startDate, finishDate
10. For creating PROJECTS - "name" and "code" are required. Optional: status, manager, scheduleStart, scheduleFinish
11. Use correct field names: taskOwner (not assignedTo), assignedResources, status, percentComplete, startDate, finishDate

User Query: "${message}"

Respond ONLY with the JSON execution plan. No explanations.`;

  // Discover available objects to inform AI
  let availableObjectsHint = '';
  try {
    const objects = await discoverAllObjects();
    const customObjects = objects.filter(o => 
      !['projects', 'tasks', 'resources', 'teams', 'ideas', 'risks', 'issues'].includes(o)
    );
    
    if (customObjects.length > 0) {
      availableObjectsHint = `\n\nAVAILABLE CUSTOM OBJECTS: ${customObjects.slice(0, 20).join(', ')}`;
      systemPrompt += availableObjectsHint;
    }
  } catch (error) {
    console.warn('[AI] Could not fetch available objects for context');
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [
          { role: 'user', content: systemPrompt }
        ]
      })
    });
    
    if (!response.ok) {
      console.error('[AI] API Error:', response.status);
      return fallbackAnalysis(message);
    }
    
    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
    };
    const content = data.content[0].text;
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const plan = JSON.parse(jsonMatch[0]);
      console.log('[AI] Generated plan:', JSON.stringify(plan, null, 2));
      return plan;
    }
    
    console.warn('[AI] Could not parse JSON');
    return fallbackAnalysis(message);
    
  } catch (error) {
    console.error('[AI] Error:', error);
    return fallbackAnalysis(message);
  }
}

function fallbackAnalysis(message: string): any {
  const lower = message.toLowerCase();
  
  if (/how many.*project/i.test(lower)) {
    return {
      steps: [{
        operation: 'count',
        objectType: 'projects',
        filters: /active/.test(lower) ? { isActive: true } : {}
      }],
      intent: 'count_projects'
    };
  }
  
  if (/(show|list).*project/i.test(lower)) {
    return {
      steps: [{
        operation: 'list',
        objectType: 'projects',
        filters: /active/.test(lower) ? { isActive: true } : {},
        limit: 50
      }],
      intent: 'list_projects'
    };
  }
  
  return {
    steps: [],
    message: "I'm not sure how to help with that. Try asking about projects, tasks, or resources.",
    intent: 'unknown'
  };
}

// ============================================================================
// EXECUTION ENGINE
// ============================================================================

async function executePlan(plan: any): Promise<any> {
  if (!plan.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return {
      success: false,
      message: plan.message || "No steps to execute"
    };
  }

  const results: any[] = [];
  
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    console.log(`\n[Step ${i + 1}/${plan.steps.length}] ${step.operation} on ${step.objectType}`);
    
    try {
      // Build intelligent query with access to previous results
      const { path, query, metadata, method, body } = await buildIntelligentQuery(step, results);
      
      // Build URL with query parameters
      const queryString = Object.keys(query).length > 0
        ? '?' + new URLSearchParams(
            Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string])
          ).toString()
        : '';
      
      // Execute request
      const result = await makeRequest(`${path}${queryString}`, method || 'GET', body);
      
      results.push({
        step: i + 1,
        operation: step.operation,
        objectType: step.objectType,
        result,
        recordCount: result._totalCount || result._results?.length || (result._internalId ? 1 : 0)
      });
      
      console.log(`[Step ${i + 1}] Success: ${result._totalCount || result._results?.length || 'created/updated'}`);
      
    } catch (error) {
      console.error(`[Step ${i + 1}] Failed:`, error);
      results.push({
        step: i + 1,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  return {
    success: true,
    results,
    plan
  };
}

// ============================================================================
// FORMAT RESPONSE
// ============================================================================

function formatResponse(execution: any): string {
  if (!execution.success) {
    return `❌ ${execution.message || 'Execution failed'}`;
  }
  
  const finalResult = execution.results[execution.results.length - 1];
  
  if (!finalResult || !finalResult.result) {
    return '❌ No results';
  }
  
  const count = finalResult.recordCount || 0;
  const operation = finalResult.operation;
  const objectType = finalResult.objectType;
  const intent = execution.plan?.intent || '';
  
  // Get the actual child type if this is a parent-child query
  const finalStep = execution.plan?.steps?.[execution.plan.steps.length - 1];
  const actualType = finalStep?.childType || objectType;
  
  // Handle CREATE operations
  if (operation === 'create') {
    const newId = finalResult.result._internalId;
    return `✅ **Created ${actualType}** (ID: ${newId})`;
  }
  
  // Handle UPDATE operations
  if (operation === 'update') {
    const updatedId = finalResult.result._internalId || finalResult.result.id;
    if (updatedId) {
      return `✅ **Updated ${actualType}** (ID: ${updatedId})`;
    } else {
      return `✅ **Updated ${actualType}**`;
    }
  }
  
  // Handle count operations
  if (operation === 'count') {
    return `📊 **Found ${count} ${actualType}**`;
  }
  
  if (count === 0) {
    return `❌ No ${actualType} found`;
  }
  
  // Handle distribution/grouping intents
  if (intent.includes('distribution') || intent.includes('by_status') || intent.includes('grouped')) {
    const items = finalResult.result._results || [];
    
    // Group by status
    const grouped: Record<string, number> = {};
    items.forEach((item: any) => {
      const status = item.status?.displayValue || item.status || 'Unknown';
      grouped[status] = (grouped[status] || 0) + 1;
    });
    
    let reply = `📊 **Task Distribution (${count} total)**\n\n`;
    Object.entries(grouped)
      .sort(([, a], [, b]) => b - a)
      .forEach(([status, taskCount]) => {
        reply += `• **${status}**: ${taskCount} tasks\n`;
      });
    
    return reply;
  }
  
  // Standard list response
  let reply = `✅ **Found ${count} ${actualType}**\n\n`;
  
  if (finalResult.result._results && finalResult.result._results.length > 0) {
    const items = finalResult.result._results.slice(0, 15).map((item: any, i: number) => {
      const name = item.name || item.code || item.uniqueName || item._internalId;
      const status = item.status?.displayValue || item.status || '';
      const extra = status ? ` (${status})` : '';
      return `${i + 1}. **${name}**${extra}`;
    }).join('\n');
    
    const more = count > 15 ? `\n\n_...and ${count - 15} more_` : '';
    reply += items + more;
  }
  
  return reply;
}

// ============================================================================
// ROUTES
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    version: '4.0.0-enhanced-intelligent-describe',
    config: {
      baseUrl: config.baseUrl,
      hasAuth: !!(config.username || config.sessionId || config.authToken),
      hasAI: !!process.env.ANTHROPIC_API_KEY,
      cacheSize: metadataCache.size
    }
  });
});

app.get('/api/discover', async (req, res) => {
  try {
    const detailed = req.query.detailed === 'true';
    
    if (detailed) {
      // Get detailed information about all objects
      console.log('[API] Fetching detailed object list...');
      
      const customObjectsUrl = '/describe?filter=(isCustom = true) and (isSystem = false)&limit=500';
      const customObjects = await makeRequest(customObjectsUrl, 'GET');
      
      const allObjectsUrl = '/describe?limit=500';
      const allObjects = await makeRequest(allObjectsUrl, 'GET');
      
      const objectDetails = allObjects._results?.map((obj: any) => ({
        resourceName: obj.resourceName,
        label: obj.label,
        objectCode: obj.objectCode,
        isCustom: obj.isCustom === true,
        description: obj.description,
        childResources: obj.childResources?.map((child: any) => child.resourceName) || [],
        httpMethods: obj.httpMethods || []
      })) || [];
      
      res.json({
        success: true,
        objects: objectDetails,
        count: objectDetails.length,
        customCount: customObjects._totalCount || 0
      });
    } else {
      // Just return object names
      const objects = await discoverAllObjects();
      res.json({
        success: true,
        objects,
        count: objects.length
      });
    }
  } catch (error) {
    res.json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get('/api/metadata/:objectName', async (req, res) => {
  try {
    const { objectName } = req.params;
    const forceRefresh = req.query.refresh === 'true';
    
    const metadata = await getObjectMetadata(objectName, forceRefresh);
    
    res.json({
      success: true,
      metadata,
      filterPattern: detectObjectFilterPattern(objectName)
    });
  } catch (error) {
    res.json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, clarityBaseUrl, claritySessionId } = req.body;
  
  console.log(`\n[Chat] User: "${message}"`);
  
  // Override config dynamically
  if (clarityBaseUrl) config.baseUrl = clarityBaseUrl;
  if (claritySessionId) {
    config.sessionId = claritySessionId;
    config.username = undefined;
    config.password = undefined;
  }
  
  try {
    // Analyze request with AI
    const plan = await analyzeUserRequest(message);
    
    // Execute plan
    const execution = await executePlan(plan);
    
    // Format response
    const reply = formatResponse(execution);
    
    res.json({
      success: true,
      reply,
      data: execution.results[execution.results.length - 1]?.result,
      _debug: { plan, execution },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[Chat] Error:', error);
    res.json({
      success: false,
      reply: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log('======================================================================');
  console.log('🚀 Clarity PPM Enhanced Intelligent Describe Server v4.0.0');
  console.log(`📡 Listening on port ${PORT}`);
  console.log(`🔗 Base URL: ${config.baseUrl}`);
  console.log(`🔐 Auth: ${config.username ? 'Basic' : config.sessionId ? 'Session' : config.authToken ? 'Token' : 'None'}`);
  console.log(`🤖 AI Agent: ${process.env.ANTHROPIC_API_KEY ? 'Enabled' : 'Disabled'}`);
  console.log('======================================================================');
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Discover: GET http://localhost:${PORT}/api/discover`);
  console.log(`Metadata: GET http://localhost:${PORT}/api/metadata/:objectName`);
  console.log(`Chat: POST http://localhost:${PORT}/api/chat`);
  console.log('======================================================================');
});
