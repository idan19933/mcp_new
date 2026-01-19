/**
 * Clarity PPM HTTP Server v4.9.3 - Filter Queryable Fields Only
 * - Only shows AI fields that are actually queryable
 * - Excludes actionType=dataOnly and secured fields
 * - Retry logic for field validation errors
 * - Better field filtering to prevent 400 errors
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
// LOOKUP VALUE CACHE
// ============================================================================

interface LookupValue {
  code: string;
  displayValue: string;
}

const lookupValuesCache = new Map<string, LookupValue[]>();
const LOOKUP_CACHE_TTL = 1000 * 60 * 30; // 30 minutes
const lookupCacheTimestamps = new Map<string, number>();

async function getLookupValues(lookupCode: string, forceRefresh: boolean = false): Promise<LookupValue[]> {
  const cacheKey = lookupCode.toLowerCase();
  const now = Date.now();
  
  if (!forceRefresh && lookupValuesCache.has(cacheKey)) {
    const timestamp = lookupCacheTimestamps.get(cacheKey) || 0;
    if (now - timestamp < LOOKUP_CACHE_TTL) {
      console.log(`[LookupCache] Using cached values for ${lookupCode}`);
      return lookupValuesCache.get(cacheKey)!;
    }
  }
  
  try {
    console.log(`[LookupCache] Fetching lookup values for ${lookupCode}...`);
    
    const result = await makeRequest(
      `/lookupValues?filter=(lookupCode = '${lookupCode}')&limit=500`
    );
    
    const values: LookupValue[] = (result._results || []).map((item: any) => ({
      code: item.code || item.value || '',
      displayValue: item.displayValue || item.label || item.name || item.code || ''
    }));
    
    lookupValuesCache.set(cacheKey, values);
    lookupCacheTimestamps.set(cacheKey, now);
    
    console.log(`[LookupCache] Cached ${values.length} values for ${lookupCode}`);
    return values;
    
  } catch (error) {
    console.error(`[LookupCache] Failed to fetch lookup values for ${lookupCode}:`, error);
    return [];
  }
}

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
  lookupCode?: string;
  lookupValues?: Array<{ code: string; displayValue: string }>;
  maxLength?: number;
  isCustom: boolean;
  actionType?: string;
  extendedType?: string;  // e.g., "percent", "double", "integer", "money", "lookup", "obs"
  isGroupable?: boolean;  // Clarity's explicit groupable flag
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
      displayName: attr.displayName || attr.label || attr.apiName || attr.name,
      required: attr.required === true || attr.isRequired === true,
      isLookup: attr.dataType === 'lookup' || attr.extendedType === 'lookup',
      lookupType: attr.lookupType,
      lookupCode: attr.lookupCode,
      lookupValues: attr.lookupValues || attr.validValues || [],
      maxLength: attr.maxLength,
      isCustom: attr.isCustom === true,
      actionType: attr.actionType,
      extendedType: attr.extendedType,
      isGroupable: attr.isGroupable
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
// VISUALIZATION DATA PREPARATION - COMPREHENSIVE LOOKUP GROUPING
// ============================================================================

interface ChartDataPoint {
  label: string;
  value: number;
  originalCode?: string;
}

interface VisualizationResult {
  groupableFields: string[];
  chartData: Record<string, ChartDataPoint[]>;
  fieldMetadata: Record<string, {
    displayName: string;
    lookupCode?: string;
    dataType: string;
  }>;
}

async function prepareVisualizationData(
  data: any[],
  metadata: ObjectMetadata,
  requestedFields?: string[]
): Promise<VisualizationResult> {
  
  console.log('[Visualization] Preparing comprehensive chart data...');
  console.log(`[Visualization] Processing ${data.length} records with ${metadata.attributes.length} attributes`);
  
  if (requestedFields && requestedFields.length > 0) {
    console.log(`[Visualization] User requested specific fields: ${requestedFields.join(', ')}`);
  }
  
  // DEBUG: Show actual fields in the data
  if (data.length > 0) {
    const dataFields = Object.keys(data[0]);
    console.log(`[Visualization] 📊 Fields present in DATA: ${dataFields.join(', ')}`);
  }
  
  // DEBUG: Show fields in metadata
  const metadataFields = metadata.attributes.map(a => a.apiName);
  console.log(`[Visualization] 📋 Fields in METADATA (first 20): ${metadataFields.slice(0, 20).join(', ')}...`);
  
  // DEBUG: Check if requested fields are in metadata
  if (requestedFields && requestedFields.length > 0) {
    requestedFields.forEach(rf => {
      const foundInMetadata = metadataFields.some(mf => mf.toLowerCase().includes(rf.toLowerCase()));
      const foundInData = data.length > 0 && Object.keys(data[0]).some(df => df.toLowerCase().includes(rf.toLowerCase()));
      console.log(`[Visualization] 🔍 Field "${rf}": in metadata=${foundInMetadata}, in data=${foundInData}`);
    });
  }
  
  const chartData: Record<string, ChartDataPoint[]> = {};
  const groupableFields: string[] = [];
  const fieldMetadata: Record<string, any> = {};
  
  // BUILD A COMBINED LIST: Only process fields that are actually in the data!
  const fieldsToProcess = new Map<string, AttributeMetadata>();
  
  // Get list of fields actually present in the data
  const dataFieldNames = data.length > 0 ? Object.keys(data[0]) : [];
  console.log(`[Visualization] 📊 Fields actually in data: ${dataFieldNames.join(', ')}`);
  
  // ONLY add metadata fields that are present in the data
  for (const attr of metadata.attributes) {
    if (dataFieldNames.includes(attr.apiName)) {
      fieldsToProcess.set(attr.apiName, attr);
    }
  }
  
  // Add fields from actual data that aren't in metadata
  if (data.length > 0) {
    for (const fieldName of dataFieldNames) {
      if (!fieldsToProcess.has(fieldName)) {
        // Create a minimal attribute metadata for this field
        const sampleValue = data[0][fieldName];
        let dataType = 'string';
        let isLookup = false;
        
        if (sampleValue && typeof sampleValue === 'object' && sampleValue._type === 'lookup') {
          dataType = 'lookup';
          isLookup = true;
        } else if (typeof sampleValue === 'number') {
          dataType = 'number';
        } else if (typeof sampleValue === 'boolean') {
          dataType = 'boolean';
        }
        
        console.log(`[Visualization] 💡 Found field "${fieldName}" in DATA but not in METADATA - adding it (type: ${dataType})`);
        
        fieldsToProcess.set(fieldName, {
          apiName: fieldName,
          dataType: dataType,
          displayName: fieldName,
          required: false,
          isLookup: isLookup,
          lookupType: undefined,
          lookupCode: undefined,
          lookupValues: [],
          maxLength: undefined,
          isCustom: false,
          actionType: undefined,
          extendedType: dataType === 'lookup' ? 'lookup' : undefined,
          isGroupable: true  // Assume groupable
        });
      }
    }
  }
  
  console.log(`[Visualization] 🎯 Total fields to process: ${fieldsToProcess.size} (only fields present in data)`);
  
  // Log explicitly groupable fields from Clarity
  const clarityGroupableFields = Array.from(fieldsToProcess.values())
    .filter(attr => (attr as any).isGroupable === true)
    .map(attr => attr.apiName);
  if (clarityGroupableFields.length > 0) {
    console.log(`[Visualization] 📌 Clarity marked ${clarityGroupableFields.length} fields as groupable: ${clarityGroupableFields.slice(0, 10).join(', ')}${clarityGroupableFields.length > 10 ? '...' : ''}`);
  }
  
  // Process each field
  for (const [fieldName, attr] of fieldsToProcess.entries()) {
    
    // SPECIAL DEBUG: Log manager field details
    if (fieldName === 'manager' || fieldName.toLowerCase().includes('manager')) {
      console.log(`\n[Visualization] ==========================================`);
      console.log(`[Visualization] 🔍 MANAGER FIELD DEBUG: ${fieldName}`);
      console.log(`  - dataType: ${attr.dataType}`);
      console.log(`  - isLookup: ${attr.isLookup}`);
      console.log(`  - lookupCode: ${attr.lookupCode}`);
      console.log(`  - displayName: ${attr.displayName}`);
      console.log(`  - Sample data from first 3 records:`);
      for (let i = 0; i < Math.min(3, data.length); i++) {
        console.log(`    Record ${i}: ${JSON.stringify(data[i]?.[fieldName])}`);
      }
      console.log(`[Visualization] ==========================================\n`);
    }
    
    // Check if this field was explicitly requested
    const explicitlyRequested = requestedFields && requestedFields.some(rf => 
      fieldName.toLowerCase().includes(rf.toLowerCase()) || 
      attr.displayName.toLowerCase().includes(rf.toLowerCase())
    );
    
    if (explicitlyRequested) {
      console.log(`[Visualization] ⭐ Field "${fieldName}" is EXPLICITLY REQUESTED by user`);
    }
    
    // Skip non-groupable fields (unless explicitly requested)
    if (!explicitlyRequested) {
      // Check if Clarity says this field is not groupable
      if ((attr as any).isGroupable === false) {
        console.log(`[Visualization] Skipping ${fieldName}: Clarity marked as not groupable`);
        continue;
      }
      
      // Skip system/technical fields
      if (attr.apiName.startsWith('_') && attr.apiName !== '_internalId') {
        console.log(`[Visualization] Skipping ${fieldName}: system field`);
        continue;
      }
      
      // Skip non-visual data types
      if (attr.dataType === 'clob' || 
          attr.dataType === 'attachment' || 
          attr.dataType === 'tsv' ||
          attr.dataType === 'richtext' ||
          attr.actionType === 'filterOnly' ||
          attr.actionType === 'dataOnly') {
        console.log(`[Visualization] Skipping ${fieldName}: non-groupable type (${attr.dataType})`);
        continue;
      }
    }
    
    // Check if this field has data in the records
    let hasData = false;
    let sampleValues = new Set<string>();
    let nullCount = 0;
    
    for (const record of data) {
      const value = record[attr.apiName];
      if (value === null || value === undefined) {
        nullCount++;
        continue;
      }
      
      hasData = true;
      
      // Extract code for counting unique values
      let code: string;
      if (typeof value === 'object' && value._type === 'lookup') {
        code = String(value.id || value.code || '');
      } else if (typeof value === 'object' && value.code !== undefined) {
        code = String(value.code);
      } else if (typeof value === 'number') {
        code = String(value);
      } else if (typeof value === 'boolean') {
        code = String(value);
      } else {
        code = String(value);
      }
      
      sampleValues.add(code);
      
      // Stop sampling after finding enough unique values
      if (sampleValues.size >= 50) break;
    }
    
    // Log statistics for explicitly requested fields
    if (explicitlyRequested) {
      console.log(`[Visualization] Field "${fieldName}" stats: ${sampleValues.size} unique values, ${nullCount} null records out of ${data.length} total`);
      if (sampleValues.size <= 10) {
        console.log(`[Visualization] Unique values: ${Array.from(sampleValues).join(', ')}`);
      }
    }
    
    // Skip if no data
    if (!hasData) {
      if (fieldName === 'manager' || fieldName.toLowerCase().includes('manager')) {
        console.log(`[Visualization] ❌ MANAGER FIELD "${fieldName}" SKIPPED: no data in records`);
      } else {
        console.log(`[Visualization] Skipping ${fieldName}: no data in records`);
      }
      continue;
    }
    
    // Skip if only one unique value (unless explicitly requested)
    if (sampleValues.size < 2 && !explicitlyRequested) {
      if (fieldName === 'manager' || fieldName.toLowerCase().includes('manager')) {
        console.log(`[Visualization] ❌ MANAGER FIELD "${fieldName}" SKIPPED: only ${sampleValues.size} unique value(s)`);
      } else {
        console.log(`[Visualization] Skipping ${fieldName}: only ${sampleValues.size} unique value(s)`);
      }
      continue;
    }
    
    // Skip if too many unique values (unless explicitly requested or it's a lookup)
    if (sampleValues.size > 100 && !explicitlyRequested && !attr.isLookup) {
      if (fieldName === 'manager' || fieldName.toLowerCase().includes('manager')) {
        console.log(`[Visualization] ❌ MANAGER FIELD "${fieldName}" SKIPPED: too many unique values (${sampleValues.size})`);
      } else {
        console.log(`[Visualization] Skipping ${fieldName}: too many unique values (${sampleValues.size})`);
      }
      continue;
    }
    
    if (fieldName === 'manager' || fieldName.toLowerCase().includes('manager')) {
      console.log(`[Visualization] ✅ MANAGER FIELD "${fieldName}" INCLUDED! (${sampleValues.size} unique values)${explicitlyRequested ? ' [USER REQUESTED]' : ''}`);
    } else {
      console.log(`[Visualization] ✓ Found groupable field: ${fieldName} (${attr.dataType}, ${sampleValues.size} unique values)${explicitlyRequested ? ' [USER REQUESTED]' : ''}`);
    }    
    groupableFields.push(attr.apiName);
    fieldMetadata[attr.apiName] = {
      displayName: attr.displayName,
      lookupCode: attr.lookupCode,
      dataType: attr.dataType
    };
    
    // Prepare lookup value map if available
    let lookupMap = new Map<string, string>();
    
    if (attr.isLookup && attr.lookupValues && attr.lookupValues.length > 0) {
      console.log(`[Visualization] Using ${attr.lookupValues.length} embedded lookup values for ${attr.apiName}`);
      for (const lv of attr.lookupValues) {
        lookupMap.set(String(lv.code), lv.displayValue);
      }
    } else if (attr.isLookup && attr.lookupCode) {
      // Fetch lookup values from API
      console.log(`[Visualization] Fetching lookup values for ${attr.apiName} (${attr.lookupCode})`);
      try {
        const lookupValues = await getLookupValues(attr.lookupCode);
        for (const lv of lookupValues) {
          lookupMap.set(String(lv.code), lv.displayValue);
        }
        console.log(`[Visualization] Loaded ${lookupValues.length} lookup values for ${attr.apiName}`);
      } catch (error) {
        console.warn(`[Visualization] Failed to fetch lookup values for ${attr.apiName}:`, error);
      }
    }
    
    // Count occurrences and build chart data
    const fieldData = new Map<string, { code: string; displayValue: string; count: number }>();
    
    for (const record of data) {
      const value = record[attr.apiName];
      if (value === null || value === undefined) continue;
      
      let code: string;
      let displayValue: string | null = null;
      
      // Handle different value formats
      if (typeof value === 'object' && value._type === 'lookup') {
        // Clarity lookup format: { displayValue, _type: "lookup", id }
        code = String(value.id || value.code || '');
        displayValue = value.displayValue || null;
      } else if (typeof value === 'object' && value.code !== undefined) {
        code = String(value.code);
        displayValue = value.displayValue || null;
      } else if (typeof value === 'boolean') {
        code = String(value);
        displayValue = value ? 'Yes' : 'No';
      } else if (typeof value === 'number') {
        code = String(value);
        // For numbers like percentComplete, check if it's a percentage
        if (attr.extendedType === 'percent' || attr.apiName.includes('percent') || attr.apiName.includes('Percent')) {
          displayValue = `${value}%`;
        } else {
          displayValue = String(value);
        }
      } else {
        code = String(value);
      }
      
      if (!code) continue;
      
      const existing = fieldData.get(code);
      if (existing) {
        existing.count++;
        // Prefer non-null displayValue
        if (displayValue && !existing.displayValue) {
          existing.displayValue = displayValue;
        }
      } else {
        // Try to get display value from lookup map if not from data
        let finalDisplayValue = displayValue;
        if (!finalDisplayValue && lookupMap.has(code)) {
          finalDisplayValue = lookupMap.get(code)!;
        }
        
        fieldData.set(code, {
          code,
          displayValue: finalDisplayValue || code,
          count: 1
        });
      }
    }
    
    // Build chart points
    const chartPoints: ChartDataPoint[] = [];
    for (const item of fieldData.values()) {
      chartPoints.push({
        label: item.displayValue,
        value: item.count,
        originalCode: item.code !== item.displayValue ? item.code : undefined
      });
    }
    
    // Sort by value descending
    chartPoints.sort((a, b) => b.value - a.value);
    
    chartData[attr.apiName] = chartPoints;
    
    const topValues = chartPoints.slice(0, 3).map(p => `${p.label}=${p.value}`).join(', ');
    console.log(`[Visualization] ${attr.apiName} (${attr.displayName}): ${chartPoints.length} categories - ${topValues}`);
  }
  
  console.log(`[Visualization] ========================================`);
  console.log(`[Visualization] SUMMARY: Created ${groupableFields.length} chart visualizations`);
  console.log(`[Visualization] Fields included: ${groupableFields.join(', ')}`);
  console.log(`[Visualization] ========================================`);
  
  return { groupableFields, chartData, fieldMetadata };
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
    // Don't filter out fields - let Clarity API reject them if invalid
    // This allows fields that exist but aren't in metadata (e.g., actionType='dataOnly')
    query.fields = intent.fields.join(',');
    
    // Just warn about fields not in metadata
    const unknownFields = intent.fields.filter(field => {
      const attr = metadata.attributes.find(a => a.apiName === field);
      return !attr && field !== '_internalId';
    });
    
    if (unknownFields.length > 0) {
      console.log(`[FieldValidation] Fields not in metadata (will try anyway): ${unknownFields.join(', ')}`);
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

**CRITICAL - UNDERSTAND USER'S SPECIFIC FIELD REQUEST:**
When the user asks for a SPECIFIC field (e.g., "show name distribution", "graph for name", "analyze status"), you MUST:
1. Include ONLY that specific field + _internalId in the fields list
2. Do NOT add other fields unless the user explicitly asks for them
3. The field the user requests is THE ONLY ONE that matters
4. If user provides field name in Hebrew or other language, look for it in the available objects list below

**IMPORTANT - USE EXACT FIELD NAMES:**
When user specifies a field name (especially in Hebrew, Arabic, or other non-English languages):
- Look for the EXACT field name in the available objects/fields list provided below
- Use the apiName exactly as shown in the metadata
- Do NOT translate or guess the field name
- Example: "אגף אחראי" → look for this exact Hebrew text in the field list → use "p_z_responsible_depart"

**IMPORTANT - HANDLE GREETINGS:**
If the user says ONLY a greeting like "hi", "hello", "hey" with NO other question, respond with:
{
  "steps": [],
  "intent": "greeting"
}

**YOUR PROCESS:**
1. Analyze the user's natural language request
2. If it's JUST a greeting → return empty steps with "greeting" intent
3. **Identify WHICH SPECIFIC FIELD the user is asking about** (name, status, manager, priority, etc.)
4. Identify the Clarity objects involved (projects, tasks, resources, etc.)
5. Determine what operation is needed (count, list, get, create, update)
6. Extract any filters or conditions
7. Return a structured execution plan

**VISUAL ANALYTICS:**
When users ask for distributions, analytics, breakdowns, or groupings:
- ALWAYS use "list" operation to get full data (not count)
- Include ONLY the SPECIFIC FIELD that the user asked for + _internalId
- If user asks for "name distribution" → fields: ["name", "_internalId"]
- If user asks for "status breakdown" → fields: ["status", "_internalId"]
- If user asks for "all fields" or "everything" → include multiple common fields
- Set limit high enough to get complete picture (500 for distributions)

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
      "fields": ["name", "_internalId"],
      "limit": 50
    }
  ],
  "intent": "brief description"
}

**EXAMPLES:**

Q: "How many active projects?"
A: {
  "steps": [{
    "operation": "count",
    "objectType": "projects",
    "filters": { "isActive": true }
  }],
  "intent": "count_active_projects"
}

Q: "Show me project name distribution"
A: {
  "steps": [{
    "operation": "list",
    "objectType": "projects",
    "fields": ["name", "_internalId"],
    "limit": 500
  }],
  "intent": "project_name_distribution_visual"
}

Q: "Create graph for project name"
A: {
  "steps": [{
    "operation": "list",
    "objectType": "projects",
    "fields": ["name", "_internalId"],
    "limit": 500
  }],
  "intent": "project_name_graph_visual"
}

Q: "Analyze task status"
A: {
  "steps": [{
    "operation": "list",
    "objectType": "tasks",
    "fields": ["status", "_internalId"],
    "limit": 500
  }],
  "intent": "task_status_analysis_visual"
}

Q: "Group projects by priority"
A: {
  "steps": [{
    "operation": "list",
    "objectType": "projects",
    "fields": ["priority", "_internalId"],
    "limit": 500
  }],
  "intent": "project_priority_grouping_visual"
}

Q: "Show distribution by manager"
A: {
  "steps": [{
    "operation": "list",
    "objectType": "projects",
    "fields": ["manager", "_internalId"],
    "limit": 500
  }],
  "intent": "project_manager_distribution_visual"
}

Q: "Create distribution of projects by blueprint"
A: {
  "steps": [{
    "operation": "list",
    "objectType": "projects",
    "fields": ["blueprintId", "_internalId"],
    "limit": 500
  }],
  "intent": "project_blueprint_distribution_visual"
}

Q: "Show me all project analytics"
A: {
  "steps": [{
    "operation": "list",
    "objectType": "projects",
    "fields": ["name", "status", "manager", "priority", "percentComplete", "_internalId"],
    "limit": 500
  }],
  "intent": "project_comprehensive_analytics_visual"
}

Q: "List projects managed by user 5001"
A: {
  "steps": [{
    "operation": "list",
    "objectType": "projects",
    "filters": { "manager": 5001 },
    "fields": ["name", "code", "status", "_internalId"],
    "limit": 50
  }],
  "intent": "list_projects_by_manager"
}

**IMPORTANT RULES:**
1. For "distribution", "breakdown", "analyze", "graph", "chart" queries - Use LIST operation with limit=500
2. **When user asks for a SPECIFIC field, include ONLY that field + _internalId, nothing else**
3. For "how many" queries - Use COUNT operation
4. For parent-child queries - Use TWO steps with parentId: "STEP_1_ID"
5. Always include _internalId in field selection
6. For CREATE/UPDATE - Use "data" field with required attributes
7. Visual analytics keywords: distribution, breakdown, analyze, show breakdown, group by, graph, chart

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
    
    // Add available fields for "projects" if query mentions it
    if (message.toLowerCase().includes('project')) {
      try {
        const projectMetadata = await getObjectMetadata('projects');
        const groupableFields = projectMetadata.attributes
          .filter(attr => {
            // Only include fields that are actually queryable
            return attr.isGroupable !== false && 
                   attr.dataType !== 'clob' &&
                   attr.dataType !== 'attachment' &&
                   attr.actionType !== 'filterOnly' &&
                   attr.actionType !== 'dataOnly' &&
                   !attr.apiName.startsWith('_') &&
                   attr.apiName !== 'actuals' &&  // Known problematic fields
                   attr.apiName !== 'status2';     // Secured field
          })
          .slice(0, 50)  // Limit to first 50 fields
          .map(attr => `${attr.apiName} (${attr.displayName})`)
          .join(', ');
        
        systemPrompt += `\n\nAVAILABLE PROJECT FIELDS (queryable only):\n${groupableFields}\n`;
        console.log('[AI] Added available project fields to context');
      } catch (error) {
        console.warn('[AI] Could not fetch project fields:', error);
      }
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
  if (/^(hi|hello|hey|greetings|good morning|good afternoon|good evening)[\s!.?]*$/i.test(lower)) {
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
  // FIXED: Handle greeting and empty steps gracefully
  if (!plan.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return {
      success: true,
      message: plan.message || "Hello! How can I help you with Clarity PPM today?",
      results: [],
      plan
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
      
      let result;
      try {
        result = await makeRequest(`${path}${queryString}`, method || 'GET', body);
      } catch (firstError: any) {
        // Check if it's an invalid attribute error
        const errorMsg = firstError?.message || String(firstError);
        if (errorMsg.includes('API-1005') && errorMsg.includes('Attribute') && query.fields) {
          console.log(`[Step ${i + 1}] Field validation failed, retrying with safe fields...`);
          
          // Retry with only _internalId and name (safe fields)
          const safeQuery = { ...query, fields: '_internalId,name' };
          const safeQueryString = Object.keys(safeQuery).length > 0
            ? '?' + new URLSearchParams(
                Object.entries(safeQuery).map(([k, v]) => [k, String(v)] as [string, string])
              ).toString()
            : '';
          
          try {
            result = await makeRequest(`${path}${safeQueryString}`, method || 'GET', body);
            console.log(`[Step ${i + 1}] Retry succeeded with safe fields`);
          } catch (retryError) {
            throw firstError; // Throw original error if retry also fails
          }
        } else {
          throw firstError; // Not a field error, throw original
        }
      }
      
      results.push({
        step: i + 1,
        operation: step.operation,
        objectType: step.objectType,
        childType: step.childType,
        result,
        metadata,
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
// FORMAT RESPONSE - ENHANCED FOR VISUAL ANALYTICS WITH LOOKUP SUPPORT
// ============================================================================

async function formatResponse(execution: any, userMessage?: string): Promise<any> {
  // FIXED: Handle greeting responses
  if (execution.plan?.intent === 'greeting' || 
      (!execution.results || execution.results.length === 0)) {
    return {
      reply: execution.message || "Hello! I'm your Clarity AI assistant. How can I help you today?",
      chartData: null
    };
  }
  
  if (!execution.success) {
    return {
      reply: `❌ ${execution.message || 'Execution failed'}`,
      chartData: null
    };
  }
  
  const finalResult = execution.results[execution.results.length - 1];
  
  if (!finalResult) {
    console.error('[FormatResponse] No finalResult in execution.results');
    return {
      reply: '❌ No results',
      chartData: null
    };
  }
  
  if (finalResult.operation === 'create') {
    console.log('[FormatResponse] CREATE operation result:', JSON.stringify(finalResult, null, 2));
  }
  
  if (!finalResult.result) {
    console.error('[FormatResponse] No result in finalResult:', JSON.stringify(finalResult, null, 2));
    return {
      reply: '❌ No results',
      chartData: null
    };
  }
  
  const count = finalResult.recordCount || 0;
  const operation = finalResult.operation;
  const objectType = finalResult.objectType;
  const intent = execution.plan?.intent || '';
  
  const steps = execution.plan?.steps;
  const finalStep = (steps && Array.isArray(steps) && steps.length > 0) 
    ? steps[steps.length - 1] 
    : null;
  const actualType = finalStep?.childType || objectType;
  
  // ENHANCED: Detect visual analytics intent
  const isVisualAnalytics = intent.includes('distribution') || 
                            intent.includes('breakdown') || 
                            intent.includes('analysis') ||
                            intent.includes('visual') ||
                            intent.includes('analytics') ||
                            intent.includes('grouped');
  
  // ENHANCED: Handle visual analytics queries with lookup resolution
  if (isVisualAnalytics && finalResult.result._results && finalResult.result._results.length > 0 && finalResult.metadata) {
    const displayLabel = await getObjectLabel(actualType);
    
    // Extract requested fields from the AI's execution plan (more reliable than parsing user message)
    const requestedFields: string[] = [];
    if (execution.plan?.steps?.[0]?.fields) {
      const planFields = execution.plan.steps[0].fields;
      // Exclude _internalId and _self
      requestedFields.push(...planFields.filter((f: string) => f !== '_internalId' && f !== '_self'));
      console.log('[Analytics] Extracted requested fields from AI plan:', requestedFields);
    }
    
    // Prepare visualization data with lookup resolution
    const vizData = await prepareVisualizationData(
      finalResult.result._results,
      finalResult.metadata,
      requestedFields.length > 0 ? requestedFields : undefined
    );
    
    // FILTER: If user requested specific fields, only return those
    let filteredChartData = vizData.chartData;
    let filteredGroupableFields = vizData.groupableFields;
    let filteredFieldMetadata = vizData.fieldMetadata;
    
    if (requestedFields.length > 0) {
      console.log('[Analytics] Filtering to user-requested fields only');
      
      filteredGroupableFields = vizData.groupableFields.filter(fieldName => {
        const fieldNameLower = fieldName.toLowerCase();
        const displayNameLower = vizData.fieldMetadata[fieldName]?.displayName?.toLowerCase() || '';
        
        return requestedFields.some(rf => {
          const rfLower = rf.toLowerCase();
          return fieldNameLower.includes(rfLower) || 
                 displayNameLower.includes(rfLower) ||
                 rfLower.includes(fieldNameLower);
        });
      });
      
      // If filtering resulted in fields, use filtered list
      if (filteredGroupableFields.length > 0) {
        const newChartData: Record<string, any> = {};
        const newFieldMetadata: Record<string, any> = {};
        
        filteredGroupableFields.forEach(fieldName => {
          newChartData[fieldName] = vizData.chartData[fieldName];
          newFieldMetadata[fieldName] = vizData.fieldMetadata[fieldName];
        });
        
        filteredChartData = newChartData;
        filteredFieldMetadata = newFieldMetadata;
        
        console.log('[Analytics] Filtered to:', filteredGroupableFields);
      } else {
        // No matches found, return all fields
        console.log('[Analytics] No matching fields found, returning all');
      }
    }
    
    const fieldCount = filteredGroupableFields.length;
    const fieldList = filteredGroupableFields
      .slice(0, 5)
      .map(f => filteredFieldMetadata[f]?.displayName || f)
      .join(', ');
    const more = fieldCount > 5 ? ` and ${fieldCount - 5} more` : '';
    
    return {
      reply: `📊 **${displayLabel} Analytics** (${count} records)\n\n✨ ${fieldCount} visualizations available: ${fieldList}${more}`,
      chartData: {
        groupableFields: filteredGroupableFields,
        chartData: filteredChartData,
        fieldMetadata: filteredFieldMetadata
      }
    };
  }
  
  if (intent.includes('list') && intent.includes('custom') && execution.results?.length > 3) {
    let reply = `📋 **Custom Objects in System**\n\n`;
    
    const listSteps = execution.results.filter((r: any) => 
      r.operation === 'list' && r.recordCount > 0
    );
    
    if (listSteps.length === 0) {
      return {
        reply: '❌ No custom objects found',
        chartData: null
      };
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
    return {
      reply,
      chartData: null
    };
  }
  
  if (intent.includes('count') && intent.includes('custom') && execution.results?.length > 3) {
    let reply = `📊 **Custom Objects in System**\n\n`;
    
    const countSteps = execution.results.filter((r: any) => 
      r.operation === 'count' && !r.error
    );
    
    if (countSteps.length === 0) {
      return {
        reply: '❌ No custom objects found',
        chartData: null
      };
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
    return {
      reply,
      chartData: null
    };
  }
  
  if (operation === 'create') {
    if (!finalResult.result) {
      return {
        reply: '❌ Create operation failed - no result returned',
        chartData: null
      };
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
    
    return {
      reply: `✅ **Created ${displayLabel}**\n${details}\nName: ${newName}`,
      chartData: null
    };
  }
  
  if (operation === 'update') {
    const updatedId = finalResult.result._internalId || finalResult.result.id;
    if (updatedId) {
      return {
        reply: `✅ **Updated ${actualType}** (ID: ${updatedId})`,
        chartData: null
      };
    } else {
      return {
        reply: `✅ **Updated ${actualType}**`,
        chartData: null
      };
    }
  }
  
  if (operation === 'count') {
    return {
      reply: `📊 **Found ${count} ${actualType}**`,
      chartData: null
    };
  }
  
  if (count === 0) {
    return {
      reply: `❌ No ${actualType} found`,
      chartData: null
    };
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
  
  return {
    reply,
    chartData: null
  };
}

// ============================================================================
// ROUTES
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    version: '4.9.3-filter-queryable-fields',
    config: {
      baseUrl: config.baseUrl,
      hasAuth: !!(config.username || config.sessionId || config.authToken),
      hasAI: !!process.env.ANTHROPIC_API_KEY,
      cacheSize: metadataCache.size,
      lookupCacheSize: lookupValuesCache.size
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
    
    const response = await formatResponse(execution, message);
    
    const lastResult = (execution.results && execution.results.length > 0)
      ? execution.results[execution.results.length - 1]?.result
      : null;
    
    res.json({
      success: true,
      reply: response.reply,
      chartData: response.chartData,
      data: lastResult,
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
  console.log('🚀 Clarity PPM Filter Queryable Fields v4.9.3');
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
  console.log('✅ Only shows queryable fields to AI');
  console.log('🛡️ Excludes secured/dataOnly fields');
  console.log('🔄 Retry logic for field errors');
  console.log('🌍 Hebrew fields working!');
  console.log('======================================================================');
});
