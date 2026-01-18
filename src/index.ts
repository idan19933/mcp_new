/**
 * Clarity PPM HTTP Server v4.1.0 - Visual Analytics Edition
 * - Enhanced with distribution and analytics support
 * - Automatic chart data preparation
 * - Smart grouping for visualizations
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
  lookupValues?: Array<{ code: string; displayValue: string }>;
  maxLength?: number;
  isCustom: boolean;
  actionType?: string;
}

const metadataCache = new Map<string, ObjectMetadata>();
const CACHE_TTL = 1000 * 60 * 15; // 15 minutes

let discoveredObjects: string[] | null = null;
let discoveredObjectsTimestamp = 0;

const objectLabelsCache = new Map<string, string>();
const objectLabelToResourceCache = new Map<string, string>();

async function getObjectLabel(resourceName: string): Promise<string> {
  if (objectLabelsCache.has(resourceName)) {
    return objectLabelsCache.get(resourceName)!;
  }
  
  try {
    const result = await makeRequest(`/describe?filter=(resourceName = '${resourceName}')&limit=1`, 'GET');
    
    if (result._results && result._results.length > 0) {
      const label = result._results[0].label || resourceName;
      objectLabelsCache.set(resourceName, label);
      objectLabelToResourceCache.set(label.toLowerCase(), resourceName);
      return label;
    }
  } catch (error) {
    console.warn(`[Labels] Could not fetch label for ${resourceName}`);
  }
  
  objectLabelsCache.set(resourceName, resourceName);
  return resourceName;
}

async function getResourceNameFromLabel(label: string): Promise<string | null> {
  const lowerLabel = label.toLowerCase();
  
  if (objectLabelToResourceCache.has(lowerLabel)) {
    return objectLabelToResourceCache.get(lowerLabel)!;
  }
  
  try {
    const result = await makeRequest(
      `/describe?filter=(isCustom = true) and (isSystem = false)&limit=500`,
      'GET'
    );
    
    if (result._results) {
      for (const obj of result._results) {
        if (obj.label && obj.resourceName) {
          objectLabelsCache.set(obj.resourceName, obj.label);
          objectLabelToResourceCache.set(obj.label.toLowerCase(), obj.resourceName);
        }
      }
      
      if (objectLabelToResourceCache.has(lowerLabel)) {
        return objectLabelToResourceCache.get(lowerLabel)!;
      }
    }
  } catch (error) {
    console.warn(`[Labels] Could not reverse lookup label: ${label}`);
  }
  
  return null;
}

async function discoverAllObjects(): Promise<string[]> {
  const now = Date.now();
  
  if (discoveredObjects && (now - discoveredObjectsTimestamp) < CACHE_TTL) {
    return discoveredObjects;
  }
  
  try {
    console.log('[Discovery] Fetching all objects from /describe...');
    
    const allObjectsUrl = '/describe?limit=500';
    const allObjects = await makeRequest(allObjectsUrl, 'GET');
    
    const customObjectsUrl = '/describe?filter=(isCustom = true) and (isSystem = false)&limit=500';
    const customObjects = await makeRequest(customObjectsUrl, 'GET');
    
    const objectNames = new Set<string>();
    
    if (allObjects._results) {
      allObjects._results.forEach((obj: any) => {
        if (obj.resourceName) {
          objectNames.add(obj.resourceName);
        }
      });
    }
    
    if (customObjects._results) {
      customObjects._results.forEach((obj: any) => {
        if (obj.resourceName) {
          objectNames.add(obj.resourceName);
        }
      });
    }
    
    discoveredObjects = Array.from(objectNames);
    discoveredObjectsTimestamp = now;
    
    console.log(`[Discovery] Found ${discoveredObjects.length} total objects`);
    console.log(`[Discovery] Custom objects count: ${customObjects._totalCount || 0}`);
    
    if (customObjects._results && customObjects._results.length > 0) {
      const customNames = customObjects._results
        .map((obj: any) => obj.resourceName)
        .filter(Boolean)
        .slice(0, 10);
      console.log(`[Discovery] Sample custom objects:`, customNames.join(', '));
    }
    
    return discoveredObjects;
  } catch (error) {
    console.error('[Discovery] Failed to discover objects:', error);
    
    discoveredObjects = [
      'projects', 'tasks', 'resources', 'teams', 'ideas', 'risks', 'issues',
      'timesheets', 'timeEntries', 'allocations', 'assignments', 'investments',
      'portfolios', 'programs', 'milestones', 'dependencies', 'workProducts'
    ];
    
    return discoveredObjects;
  }
}

function resolveLookupValue(metadata: ObjectMetadata, fieldName: string, displayValue: string): string {
  const attribute = metadata.attributes.find(attr => attr.apiName === fieldName);
  
  if (!attribute || !attribute.isLookup) {
    console.log(`[LookupResolver] ${fieldName} is not a lookup field`);
    return displayValue;
  }
  
  if (!attribute.lookupValues || attribute.lookupValues.length === 0) {
    console.warn(`[LookupResolver] No lookup values available for ${fieldName}. Metadata might not include them.`);
    return displayValue;
  }
  
  console.log(`[LookupResolver] Available values for ${fieldName}:`, 
    JSON.stringify(attribute.lookupValues.map(lv => ({ code: lv.code, display: lv.displayValue })), null, 2));
  
  const lowerDisplay = displayValue.toLowerCase();
  const exactMatch = attribute.lookupValues.find(lv => 
    lv.displayValue?.toLowerCase() === lowerDisplay
  );
  
  if (exactMatch) {
    console.log(`[LookupResolver] ✓ Resolved '${displayValue}' -> '${exactMatch.code}' for ${fieldName}`);
    return exactMatch.code;
  }
  
  const partialMatch = attribute.lookupValues.find(lv =>
    lv.displayValue?.toLowerCase().includes(lowerDisplay) ||
    lowerDisplay.includes(lv.displayValue?.toLowerCase() || '')
  );
  
  if (partialMatch) {
    console.log(`[LookupResolver] ✓ Resolved '${displayValue}' -> '${partialMatch.code}' for ${fieldName} (partial match)`);
    return partialMatch.code;
  }
  
  const codeMatch = attribute.lookupValues.find(lv => lv.code === displayValue);
  if (codeMatch) {
    console.log(`[LookupResolver] ✓ '${displayValue}' is already a valid code for ${fieldName}`);
    return displayValue;
  }
  
  console.warn(`[LookupResolver] ✗ Could not resolve '${displayValue}' for ${fieldName}`);
  console.warn(`[LookupResolver] Available: ${attribute.lookupValues.map(lv => `${lv.code}=${lv.displayValue}`).join(', ')}`);
  
  return displayValue;
}

// ============================================================================
// METADATA DISCOVERY
// ============================================================================

function detectObjectFilterPattern(objectName: string): 'full' | 'simple' {
  const lowerName = objectName.toLowerCase();
  
  if (lowerName.startsWith('oba')) {
    return 'simple';
  }
  
  const standardObjects = [
    'projects', 'tasks', 'resources', 'timesheets', 'ideas', 'risks', 
    'issues', 'users', 'allocations', 'agreements'
  ];
  
  if (standardObjects.includes(lowerName)) {
    return 'full';
  }
  
  return 'full';
}

async function getObjectMetadata(objectName: string, forceRefresh: boolean = false): Promise<ObjectMetadata> {
  const cacheKey = objectName.toLowerCase();
  
  if (!forceRefresh && metadataCache.has(cacheKey)) {
    const cached = metadataCache.get(cacheKey)!;
    if (Date.now() - cached.lastUpdated < CACHE_TTL) {
      console.log(`[Metadata] Using cached metadata for ${objectName}`);
      return cached;
    }
  }
  
  console.log(`[Metadata] Fetching metadata for ${objectName}...`);
  
  try {
    const describeResult = await makeRequest(
      `/describe/${objectName}?filter=(excludeAttributes = false)`
    );
    
    const filterPattern = detectObjectFilterPattern(objectName);
    
    let attributesUrl: string;
    
    if (filterPattern === 'full') {
      attributesUrl = `/describeAttributes?filter=((resourceName = '${objectName}') and (honorFieldLevelSecurity = true) and (dataType notIn ('clob','attachment')) and (includeObjFilters = true) and (actionType != 'dataOnly'))&limit=1500&_totalCount=false`;
    } else {
      attributesUrl = `/describeAttributes?filter=((resourceName = '${objectName}') and (honorFieldLevelSecurity = true))&limit=1500&_totalCount=false`;
    }
    
    console.log(`[Metadata] Using ${filterPattern} filter pattern`);
    
    let attributesResult;
    try {
      attributesResult = await makeRequest(attributesUrl);
    } catch (error) {
      if (filterPattern === 'full') {
        console.log(`[Metadata] Full pattern failed, trying simple pattern...`);
        attributesUrl = `/describeAttributes?filter=((resourceName = '${objectName}') and (honorFieldLevelSecurity = true))&limit=1500&_totalCount=false`;
        attributesResult = await makeRequest(attributesUrl);
      } else {
        throw error;
      }
    }
    
    const attributes: AttributeMetadata[] = (attributesResult._results || []).map((attr: any) => ({
      apiName: attr.apiName || attr.name,
      dataType: attr.dataType || 'string',
      displayName: attr.displayName || attr.apiName || attr.name,
      required: attr.required === true,
      isLookup: attr.dataType === 'lookup',
      lookupType: attr.lookupType,
      lookupValues: attr.lookupValues || attr.validValues || [],
      maxLength: attr.maxLength,
      isCustom: attr.isCustom === true,
      actionType: attr.actionType
    }));
    
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
    
    metadataCache.set(cacheKey, metadata);
    console.log(`[Metadata] Cached ${attributes.length} attributes for ${objectName}`);
    
    return metadata;
    
  } catch (error) {
    console.error(`[Metadata] Failed to fetch metadata for ${objectName}:`, error);
    throw error;
  }
}

function getSmartFieldSelection(metadata: ObjectMetadata, maxFields: number = 15): string[] {
  const priorityFields = ['_internalId', 'name', 'code', 'uniqueName', 'status'];
  
  const filteredAttributes = metadata.attributes
    .filter(attr => {
      if (attr.dataType === 'clob' || attr.dataType === 'attachment') return false;
      if (attr.apiName === 'attachment') return false;
      
      if (attr.actionType === 'filterOnly' || attr.actionType === 'dataOnly') return false;
      
      if (priorityFields.includes(attr.apiName)) return true;
      
      return attr.apiName !== '_links' && 
             (!attr.apiName.startsWith('_') || attr.apiName === '_internalId');
    })
    .sort((a, b) => {
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
  recordId?: number | string;
  data?: Record<string, any>;
}

async function buildIntelligentQuery(intent: QueryIntent, previousResults?: any[]): Promise<any> {
  console.log('[QueryBuilder] Building query for:', JSON.stringify(intent, null, 2));
  
  const metadata = await getObjectMetadata(intent.objectType);
  
  let path = `/${intent.objectType}`;
  let method = 'GET';
  let query: Record<string, string | number> = {};
  let body: any = null;
  
  if (intent.operation === 'update' && intent.recordId) {
    let actualRecordId = intent.recordId;
    
    if (typeof actualRecordId === 'string' && actualRecordId.includes('STEP_')) {
      const stepMatch = actualRecordId.match(/STEP_(\d+)_ID/);
      if (stepMatch && previousResults) {
        const stepIndex = parseInt(stepMatch[1]) - 1;
        const previousResult = previousResults[stepIndex];
        
        if (previousResult?.result?._internalId) {
          actualRecordId = previousResult.result._internalId;
          console.log(`[QueryBuilder] Resolved ${intent.recordId} to ${actualRecordId}`);
        } else if (previousResult?.result?._results?.[0]?._internalId) {
          actualRecordId = previousResult.result._results[0]._internalId;
          console.log(`[QueryBuilder] Resolved ${intent.recordId} to ${actualRecordId}`);
        }
      }
    }
    
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
      
      const childMetadata = await getObjectMetadata(intent.childType);
      metadata.attributes = childMetadata.attributes;
    } else {
      path = `/${intent.objectType}/${actualRecordId}`;
    }
    
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
      
      if (resolvedBody.status && intent.childType === 'tasks') {
        const statusValue = String(resolvedBody.status).toLowerCase();
        
        if (statusValue.includes('complet') || statusValue.includes('close') || 
            statusValue === 'c' || statusValue === 'co') {
          if (!resolvedBody.percentComplete) {
            resolvedBody.percentComplete = 100;
            console.log('[BusinessLogic] Auto-set percentComplete=100 for completed status');
          }
        }
        
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
  
  if (intent.operation === 'create') {
    method = 'POST';
    body = intent.data || {};
    
    console.log(`[QueryBuilder] CREATE operation for ${intent.objectType}`);
    console.log(`[QueryBuilder] Data to create:`, JSON.stringify(body, null, 2));
    
    if (intent.objectType && intent.objectType.toLowerCase().startsWith('cust')) {
      if (body.name && !body.code) {
        body.code = body.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() + '_' + Date.now();
        console.log(`[QueryBuilder] Auto-generated code: ${body.code}`);
      } else if (!body.name && body.code) {
        body.name = body.code;
        console.log(`[QueryBuilder] Using code as name: ${body.name}`);
      } else if (!body.name && !body.code) {
        const timestamp = Date.now();
        body.name = `record_${timestamp}`;
        body.code = `record_${timestamp}`;
        console.log(`[QueryBuilder] Auto-generated name and code: ${body.name}`);
      }
    }
    
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
      
      const childMetadata = await getObjectMetadata(intent.childType);
      metadata.attributes = childMetadata.attributes;
    }
    
    console.log(`[QueryBuilder] Final CREATE path: ${path}`);
    console.log(`[QueryBuilder] Final CREATE body:`, JSON.stringify(body, null, 2));
    
    if (body && typeof body === 'object') {
      const resolvedBody: Record<string, any> = {};
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') {
          resolvedBody[key] = resolveLookupValue(metadata, key, value);
        } else {
          resolvedBody[key] = value;
        }
      }
      
      if (resolvedBody.status && intent.childType === 'tasks') {
        const statusValue = String(resolvedBody.status).toLowerCase();
        
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
    
    const childMetadata = await getObjectMetadata(intent.childType);
    metadata.attributes = childMetadata.attributes;
  }
  
  if (intent.operation === 'count') {
    query.fields = '_internalId';
    query.limit = 500;
  } else if (intent.fields && intent.fields.length > 0) {
    const validFields = intent.fields.filter(field => {
      const attr = metadata.attributes.find(a => a.apiName === field);
      if (!attr && field !== '_internalId') {
        console.warn(`[FieldValidation] Field '${field}' not found in metadata, excluding`);
        return false;
      }
      return true;
    });
    
    if (validFields.length === 0) {
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
  
  if (intent.limit) {
    query.limit = Math.min(intent.limit, 500);
  } else if (!query.limit) {
    query.limit = intent.operation === 'count' ? 500 : 50;
  }
  
  return { path, query, metadata, method, body };
}

// ============================================================================
// AI AGENT WITH CLAUDE ANALYSIS - ENHANCED FOR VISUAL ANALYTICS
// ============================================================================

async function analyzeUserRequest(message: string): Promise<any> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  
  if (!ANTHROPIC_API_KEY) {
    console.log('[AI] No API key, using fallback');
    return fallbackAnalysis(message);
  }

  let systemPrompt = `You are a Clarity PPM API expert that uses intelligent metadata discovery and creates visual analytics.

**IMPORTANT - HANDLE GREETINGS:**
If the user says ONLY a greeting like "hi", "hello", "hey" with NO other question, respond with:
{
  "steps": [],
  "intent": "greeting"
}

**YOUR PROCESS:**
1. Analyze the user's natural language request
2. If it's JUST a greeting → return empty steps with "greeting" intent
3. Identify the Clarity objects involved (projects, tasks, resources, etc.)
4. Determine what operation is needed (count, list, get, create, update)
5. Extract any filters or conditions
6. Return a structured execution plan

**VISUAL ANALYTICS:**
When users ask for distributions, analytics, breakdowns, or groupings:
- ALWAYS use "list" operation to get full data (not count)
- Include the grouping field (status, percentComplete, priority, type, category)
- Set limit high enough to get complete picture (500 for distributions)
- The frontend will automatically create charts for data with groupable fields

**AVAILABLE OPERATIONS:**
- count: Count records (returns total number)
- list: List multiple records with details - USE THIS FOR DISTRIBUTIONS/ANALYTICS
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

Q: "Show task status distribution for project Alpha"
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
      "fields": ["name", "status", "percentComplete", "_internalId"],
      "limit": 500
    }
  ],
  "intent": "task_status_distribution_visual"
}

Q: "Break down completion for project Beta"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "projects",
      "filters": { "name": "Beta" },
      "fields": ["_internalId", "name"]
    },
    {
      "operation": "list",
      "objectType": "projects",
      "parentId": "STEP_1_ID",
      "childType": "tasks",
      "fields": ["name", "percentComplete", "status", "_internalId"],
      "limit": 500
    }
  ],
  "intent": "completion_breakdown_visual"
}

Q: "Analyze task priorities"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "tasks",
      "fields": ["name", "priority", "status", "_internalId"],
      "limit": 500
    }
  ],
  "intent": "priority_distribution_visual"
}

Q: "Show distribution of custTaskUpdates"
A: {
  "steps": [
    {
      "operation": "list",
      "objectType": "custTaskUpdates",
      "fields": ["name", "status", "_internalId"],
      "limit": 500
    }
  ],
  "intent": "custom_object_distribution_visual"
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

**IMPORTANT RULES:**
1. For "distribution", "breakdown", "analyze" queries - Use LIST operation with limit=500
2. Include groupable fields: status, percentComplete, priority, type, category
3. For "how many" queries - Use COUNT operation
4. For parent-child queries - Use TWO steps with parentId: "STEP_1_ID"
5. Always include _internalId in field selection
6. For CREATE/UPDATE - Use "data" field with required attributes
7. Visual analytics keywords: distribution, breakdown, analyze, show breakdown, group by

User Query: "${message}"

Respond ONLY with the JSON execution plan. No explanations.`;

  let availableObjectsHint = '';
  try {
    const objects = await discoverAllObjects();
    
    const standardObjects = [
      'projects', 'tasks', 'resources', 'teams', 'ideas', 'risks', 'issues',
      'timesheets', 'allocations', 'assignments', 'users', 'agreements',
      'portfolios', 'programs', 'milestones', 'dependencies', 'workProducts',
      'investments', 'objectives', 'roadmaps', 'conversations', 'documents',
      'captcha', 'certs', 'changes', 'metadata', 'describe', 'lookup'
    ];
    
    const customObjects = objects.filter(o => {
      const lower = o.toLowerCase();
      return lower.startsWith('cust') || !standardObjects.includes(lower);
    });
    
    if (customObjects.length > 0) {
      console.log(`[AI] Found ${customObjects.length} custom objects:`, customObjects.slice(0, 10).join(', '));
      
      const customObjUrl = `/describe?filter=(isCustom = true) and (isSystem = false)&limit=500`;
      const customObjResult = await makeRequest(customObjUrl, 'GET');
      
      const labelMappings: string[] = [];
      if (customObjResult._results) {
        customObjResult._results.forEach((obj: any) => {
          if (obj.resourceName && obj.label) {
            labelMappings.push(`"${obj.label}" = ${obj.resourceName}`);
            objectLabelsCache.set(obj.resourceName, obj.label);
            objectLabelToResourceCache.set(obj.label.toLowerCase(), obj.resourceName);
          }
        });
      }
      
      availableObjectsHint = `\n\nAVAILABLE CUSTOM OBJECTS (use these for custom data):\n`;
      availableObjectsHint += `${customObjects.slice(0, 30).join(', ')}\n\n`;
      
      if (labelMappings.length > 0) {
        availableObjectsHint += `LABEL TO RESOURCE MAPPING (use resourceName in queries):\n`;
        availableObjectsHint += labelMappings.slice(0, 20).join('\n');
      }
      
      systemPrompt += availableObjectsHint;
    } else {
      console.log('[AI] No custom objects found');
    }
  } catch (error) {
    console.warn('[AI] Could not fetch available objects for context:', error);
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
  const lower = message.toLowerCase().trim();
  
  // Handle greetings
  if (/^(hi|hello|hey|greetings|good morning|good afternoon|good evening)$/i.test(lower)) {
    return {
      steps: [],
      message: "Hello! I'm your Clarity AI assistant. I can help you with:\n\n• View projects, tasks, and custom objects\n• Create visual analytics and distributions\n• Count records and generate reports\n• Create and update data\n\nTry asking: 'Show task distribution for project Alpha' or 'How many active projects?'",
      intent: 'greeting'
    };
  }
  
  // Check for distribution/analytics keywords
  if (/distribution|breakdown|analyze|group.*by/i.test(lower)) {
    if (/task/i.test(lower)) {
      return {
        steps: [{
          operation: 'list',
          objectType: 'tasks',
          fields: ['name', 'status', 'percentComplete', 'priority', '_internalId'],
          limit: 500
        }],
        intent: 'task_distribution_visual'
      };
    }
  }
  
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
      const { path, query, metadata, method, body } = await buildIntelligentQuery(step, results);
      
      const queryString = Object.keys(query).length > 0
        ? '?' + new URLSearchParams(
            Object.entries(query).map(([k, v]) => [k, String(v)] as [string, string])
          ).toString()
        : '';
      
      const result = await makeRequest(`${path}${queryString}`, method || 'GET', body);
      
      results.push({
        step: i + 1,
        operation: step.operation,
        objectType: step.objectType,
        childType: step.childType,
        result,
        recordCount: result._totalCount || result._results?.length || (result._internalId ? 1 : 0)
      });
      
      const displayCount = result._totalCount || result._results?.length || (result._internalId ? 1 : 0);
      console.log(`[Step ${i + 1}] Success: ${displayCount > 0 ? displayCount : 'created/updated'}`);
      
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
// FORMAT RESPONSE - ENHANCED FOR VISUAL ANALYTICS
// ============================================================================

async function formatResponse(execution: any): Promise<string> {
  if (!execution.success) {
    return `❌ ${execution.message || 'Execution failed'}`;
  }
  
  const finalResult = execution.results[execution.results.length - 1];
  
  if (!finalResult) {
    console.error('[FormatResponse] No finalResult in execution.results');
    return '❌ No results';
  }
  
  if (finalResult.operation === 'create') {
    console.log('[FormatResponse] CREATE operation result:', JSON.stringify(finalResult, null, 2));
  }
  
  if (!finalResult.result) {
    console.error('[FormatResponse] No result in finalResult:', JSON.stringify(finalResult, null, 2));
    return '❌ No results';
  }
  
  const count = finalResult.recordCount || 0;
  const operation = finalResult.operation;
  const objectType = finalResult.objectType;
  const intent = execution.plan?.intent || '';
  
  const finalStep = execution.plan?.steps?.[execution.plan.steps?.length - 1];
  const actualType = finalStep?.childType || objectType;
  
  // ENHANCED: Detect visual analytics intent
  const isVisualAnalytics = intent.includes('distribution') || 
                            intent.includes('breakdown') || 
                            intent.includes('analysis') ||
                            intent.includes('visual') ||
                            intent.includes('analytics') ||
                            intent.includes('grouped');
  
  // ENHANCED: Handle visual analytics queries
  if (isVisualAnalytics && finalResult.result._results && finalResult.result._results.length > 0) {
    const displayLabel = await getObjectLabel(actualType);
    return `📊 **${displayLabel} Analytics** (${count} records)\n\n✨ Chart visualization will render below`;
  }
  
  if (intent.includes('list') && intent.includes('custom') && execution.results?.length > 3) {
    let reply = `📋 **Custom Objects in System**\n\n`;
    
    const listSteps = execution.results.filter((r: any) => 
      r.operation === 'list' && r.recordCount > 0
    );
    
    if (listSteps.length === 0) {
      return '❌ No custom objects found';
    }
    
    const displayPromises = listSteps.map(async (step: any) => {
      const stepType = step.childType || step.objectType;
      const stepCount = step.recordCount || 0;
      const displayLabel = await getObjectLabel(stepType);
      
      return {
        label: displayLabel,
        resourceName: stepType,
        count: stepCount
      };
    });
    
    const displayItems = await Promise.all(displayPromises);
    
    displayItems.forEach((item, i) => {
      reply += `${i + 1}. **${item.label}** (${item.resourceName}): ${item.count} records\n`;
    });
    
    reply += `\n_Total: ${listSteps.length} custom objects with data_`;
    return reply;
  }
  
  if (intent.includes('count') && intent.includes('custom') && execution.results?.length > 3) {
    let reply = `📊 **Custom Objects in System**\n\n`;
    
    const countSteps = execution.results.filter((r: any) => 
      r.operation === 'count' && !r.error
    );
    
    if (countSteps.length === 0) {
      return '❌ No custom objects found';
    }
    
    countSteps.sort((a: any, b: any) => (b.recordCount || 0) - (a.recordCount || 0));
    
    let totalRecords = 0;
    const displayPromises = countSteps.map(async (step: any) => {
      const stepType = step.objectType;
      const stepCount = step.recordCount || 0;
      totalRecords += stepCount;
      
      const displayLabel = await getObjectLabel(stepType);
      
      return {
        label: displayLabel,
        resourceName: stepType,
        count: stepCount
      };
    });
    
    const displayItems = await Promise.all(displayPromises);
    
    displayItems.forEach((item, i) => {
      if (item.count > 0) {
        reply += `${i + 1}. **${item.label}** (${item.resourceName}): ${item.count} records\n`;
      }
    });
    
    const objectsWithData = countSteps.filter((s: any) => s.recordCount > 0).length;
    reply += `\n_Found ${objectsWithData} custom objects with ${totalRecords} total records_`;
    return reply;
  }
  
  if (operation === 'create') {
    if (!finalResult.result) {
      return '❌ Create operation failed - no result returned';
    }
    
    const newId = finalResult.result._internalId || finalResult.result.code;
    const newName = finalResult.result.name || 'Unnamed';
    const newCode = finalResult.result.code || '';
    const displayLabel = await getObjectLabel(actualType);
    
    let details = `(ID: ${newId}`;
    if (newCode && newCode !== newId) {
      details += `, Code: ${newCode}`;
    }
    details += ')';
    
    return `✅ **Created ${displayLabel}**\n${details}\nName: ${newName}`;
  }
  
  if (operation === 'update') {
    const updatedId = finalResult.result._internalId || finalResult.result.id;
    if (updatedId) {
      return `✅ **Updated ${actualType}** (ID: ${updatedId})`;
    } else {
      return `✅ **Updated ${actualType}**`;
    }
  }
  
  if (operation === 'count') {
    return `📊 **Found ${count} ${actualType}**`;
  }
  
  if (count === 0) {
    return `❌ No ${actualType} found`;
  }
  
  const displayLabel = await getObjectLabel(actualType);
  let reply = `✅ **Found ${count} ${displayLabel}**\n\n`;
  
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
    version: '4.1.0-visual-analytics',
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
    const refresh = req.query.refresh === 'true';
    
    if (refresh) {
      discoveredObjects = null;
      discoveredObjectsTimestamp = 0;
      console.log('[API] Forced discovery cache refresh');
    }
    
    if (detailed) {
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
  
  if (clarityBaseUrl) config.baseUrl = clarityBaseUrl;
  if (claritySessionId) {
    config.sessionId = claritySessionId;
    config.username = undefined;
    config.password = undefined;
  }
  
  try {
    const plan = await analyzeUserRequest(message);
    
    const execution = await executePlan(plan);
    
    const reply = await formatResponse(execution);
    
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
  console.log('🚀 Clarity PPM Visual Analytics Server v4.1.0');
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
  console.log('📊 Visual Analytics Enabled - Ask for distributions, breakdowns, analytics!');
  console.log('======================================================================');
});
