/**
 * Clarity PPM HTTP Server v5.0.0 - Metadata-First Analytics Edition
 * 
 * NEW EXECUTION FLOW:
 * 1. Describe Object → Validate object exists
 * 2. Describe Attributes → Get field metadata, identify lookups
 * 3. Fetch Data → Get actual records
 * 4. Fetch Lookups → Get lookup display values (if needed)
 * 5. Aggregate → Group/distribute data programmatically
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

  console.log(`[API] ${method} ${fullUrl}`);

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
    console.error(`[API FAIL] ${fullUrl}:`, error);
    throw error;
  }
}

// ============================================================================
// TYPES FOR METADATA-FIRST APPROACH
// ============================================================================

interface AttributeInfo {
  apiName: string;
  displayName: string;
  dataType: string;
  isLookup: boolean;
  lookupType?: string;
  lookupId?: string;
  required: boolean;
  isCustom: boolean;
}

interface ObjectDescribe {
  resourceName: string;
  objectCode: string;
  label: string;
  isCustom: boolean;
  childResources: string[];
}

interface LookupValue {
  id: string;
  code: string;
  displayValue: string;
}

interface DistributionResult {
  field: string;
  fieldLabel: string;
  totalRecords: number;
  distribution: Array<{
    value: string;
    displayValue: string;
    count: number;
    percentage: number;
  }>;
}

// ============================================================================
// STEP 1: DESCRIBE OBJECT
// ============================================================================

async function describeObject(objectName: string): Promise<ObjectDescribe> {
  console.log(`\n[STEP 1] Describing object: ${objectName}`);
  
  try {
    const result = await makeRequest(`/describe/${objectName}`);
    
    const describe: ObjectDescribe = {
      resourceName: result.resourceName || objectName,
      objectCode: result.objectCode || objectName,
      label: result.label || objectName,
      isCustom: result.isCustom === true,
      childResources: (result.childResources || []).map((c: any) => c.resourceName || c)
    };
    
    console.log(`[STEP 1] ✓ Object "${describe.label}" (${describe.resourceName}) exists`);
    console.log(`[STEP 1]   - Custom: ${describe.isCustom}`);
    console.log(`[STEP 1]   - Children: ${describe.childResources.join(', ') || 'none'}`);
    
    return describe;
  } catch (error) {
    console.error(`[STEP 1] ✗ Object "${objectName}" not found or inaccessible`);
    throw new Error(`Object "${objectName}" does not exist or is not accessible`);
  }
}

// ============================================================================
// STEP 2: DESCRIBE ATTRIBUTES
// ============================================================================

async function describeAttributes(objectName: string): Promise<Map<string, AttributeInfo>> {
  console.log(`\n[STEP 2] Fetching attributes for: ${objectName}`);
  
  const attributeMap = new Map<string, AttributeInfo>();
  
  try {
    // Strategy 1: Use the filter that matches what Clarity UI uses
    // But without the dataType filter which might exclude some fields
    let url = `/describeAttributes?filter=((resourceName = '${objectName}') and (honorFieldLevelSecurity = true))&limit=1500&_totalCount=false`;
    
    console.log(`[STEP 2] Fetching with permissive filter...`);
    let result = await makeRequest(url);
    
    if (!result._results || result._results.length === 0) {
      // Fallback to even simpler filter
      console.log(`[STEP 2] No results, trying simpler filter...`);
      url = `/describeAttributes?filter=(resourceName = '${objectName}')&limit=1500`;
      result = await makeRequest(url);
    }
    
    if (!result._results || result._results.length === 0) {
      console.warn(`[STEP 2] No attributes found for ${objectName}`);
      return attributeMap;
    }
    
    const lookupFields: string[] = [];
    const referenceFields: string[] = [];
    const obsFields: string[] = []; // OBS/partition fields
    
    for (const attr of result._results) {
      const apiName = attr.apiName || attr.name;
      if (!apiName) continue;
      
      const info: AttributeInfo = {
        apiName: apiName,
        displayName: attr.displayName || attr.apiName || attr.name,
        dataType: attr.dataType || 'string',
        // Check for lookup, reference, OBS types
        isLookup: attr.dataType === 'lookup' || 
                  attr.dataType === 'reference' || 
                  attr.dataType === 'parameterizedLookup' ||
                  attr.dataType === 'obs',
        lookupType: attr.lookupType || attr.referenceType || attr.obsType,
        lookupId: attr.lookupId || attr.lookupAttributeId || attr.referenceObjectId || attr.obsId,
        required: attr.required === true,
        isCustom: attr.isCustom === true
      };
      
      // Store by apiName
      attributeMap.set(info.apiName, info);
      
      // Also store by lowercase apiName for case-insensitive lookup
      attributeMap.set(info.apiName.toLowerCase(), info);
      
      // Track field types for logging
      if (attr.dataType === 'lookup' || attr.dataType === 'parameterizedLookup') {
        lookupFields.push(`${info.apiName}`);
      }
      if (attr.dataType === 'reference') {
        referenceFields.push(`${info.apiName}`);
      }
      if (attr.dataType === 'obs' || info.apiName.toLowerCase().includes('partition') || info.apiName.toLowerCase().includes('obs')) {
        obsFields.push(`${info.apiName} (${attr.dataType})`);
      }
    }
    
    console.log(`[STEP 2] ✓ Found ${result._results.length} attributes`);
    
    if (lookupFields.length > 0) {
      console.log(`[STEP 2]   - Lookup fields (${lookupFields.length}): ${lookupFields.slice(0, 8).join(', ')}${lookupFields.length > 8 ? '...' : ''}`);
    }
    if (referenceFields.length > 0) {
      console.log(`[STEP 2]   - Reference fields (${referenceFields.length}): ${referenceFields.slice(0, 8).join(', ')}${referenceFields.length > 8 ? '...' : ''}`);
    }
    if (obsFields.length > 0) {
      console.log(`[STEP 2]   - OBS/Partition fields: ${obsFields.join(', ')}`);
    }
    
    // Debug: List some common fields that might be requested
    const commonFields = ['status', 'blueprintId', 'blueprint', 'manager', 'priority', 'category', 'type', 
                         'partition', 'partitionId', 'obsUnit', 'obs', 'department', 'investmentType', 'stage'];
    const foundCommon = commonFields.filter(f => attributeMap.has(f) || attributeMap.has(f.toLowerCase()));
    console.log(`[STEP 2]   - Common fields found: ${foundCommon.join(', ') || 'checking...'}`);
    
    // Extra debug: Find any field containing 'partition' or 'obs'
    const partitionLike = Array.from(attributeMap.values())
      .filter(a => a.apiName && (
        a.apiName.toLowerCase().includes('partition') || 
        a.apiName.toLowerCase().includes('obs') ||
        a.dataType === 'obs'
      ))
      .map(a => `${a.apiName} (${a.dataType})`);
    
    if (partitionLike.length > 0) {
      console.log(`[STEP 2]   - Partition/OBS-like fields: ${partitionLike.join(', ')}`);
    }
    
    return attributeMap;
    
  } catch (error) {
    console.error(`[STEP 2] ✗ Failed to get attributes:`, error);
    throw error;
  }
}

// ============================================================================
// STEP 3: FETCH DATA
// ============================================================================

interface FetchDataOptions {
  objectName: string;
  parentId?: string;
  childType?: string;
  fields: string[];
  filters?: Record<string, any>;
  limit?: number;
}

async function fetchData(options: FetchDataOptions): Promise<any[]> {
  console.log(`\n[STEP 3] Fetching data from: ${options.objectName}`);
  
  let path = `/${options.objectName}`;
  
  // Handle parent-child relationship
  if (options.parentId && options.childType) {
    path = `/${options.objectName}/${options.parentId}/${options.childType}`;
    console.log(`[STEP 3]   - Child resource: ${options.childType} under parent ${options.parentId}`);
  }
  
  const query: Record<string, string> = {};
  
  // Fields
  if (options.fields.length > 0) {
    query.fields = options.fields.join(',');
  }
  
  // Filters
  if (options.filters && Object.keys(options.filters).length > 0) {
    const filterParts = Object.entries(options.filters).map(([key, value]) => {
      if (value === null) return `(${key} = null)`;
      if (typeof value === 'boolean') return `(${key} = ${value})`;
      if (typeof value === 'number') return `(${key} = ${value})`;
      return `(${key} = '${value}')`;
    });
    query.filter = filterParts.length === 1 ? filterParts[0] : `(${filterParts.join(' and ')})`;
  }
  
  // Limit
  query.limit = String(options.limit || 500);
  
  const queryString = Object.entries(query)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  
  const fullPath = queryString ? `${path}?${queryString}` : path;
  
  try {
    const result = await makeRequest(fullPath);
    const records = result._results || [];
    const totalCount = result._totalCount || records.length;
    
    console.log(`[STEP 3] ✓ Fetched ${records.length} records (total: ${totalCount})`);
    
    return records;
  } catch (error) {
    console.error(`[STEP 3] ✗ Failed to fetch data:`, error);
    throw error;
  }
}

// ============================================================================
// STEP 4: FETCH LOOKUP VALUES
// ============================================================================

async function fetchLookupValues(
  objectName: string, 
  attributeName: string, 
  attributeInfo: AttributeInfo
): Promise<Map<string, LookupValue>> {
  console.log(`\n[STEP 4] Fetching lookup values for: ${attributeName}`);
  console.log(`[STEP 4]   - Data type: ${attributeInfo.dataType}`);
  console.log(`[STEP 4]   - Lookup type: ${attributeInfo.lookupType || 'N/A'}`);
  
  const lookupMap = new Map<string, LookupValue>();
  
  try {
    // Method 1: For reference fields (like blueprintId -> investments)
    if (attributeInfo.dataType === 'reference' || attributeName.endsWith('Id')) {
      console.log(`[STEP 4] Reference field detected, fetching from referenced object`);
      
      // Try to determine the referenced object
      let refObject = attributeInfo.lookupType;
      
      // Common reference mappings
      const referenceMap: Record<string, string> = {
        'blueprintId': 'investments',
        'blueprint': 'investments',
        'managerId': 'resources',
        'manager': 'resources',
        'partition': 'partitions',
        'partitionId': 'partitions',
        'primaryOwner': 'resources',
        'primaryOwnerId': 'resources',
        'createdBy': 'resources',
        'updatedBy': 'resources'
      };
      
      if (!refObject && referenceMap[attributeName]) {
        refObject = referenceMap[attributeName];
      }
      
      if (refObject) {
        try {
          console.log(`[STEP 4] Fetching from referenced object: ${refObject}`);
          const refResult = await makeRequest(`/${refObject}?fields=_internalId,name,code&limit=200`);
          
          if (refResult._results) {
            for (const item of refResult._results) {
              const lookup: LookupValue = {
                id: String(item._internalId),
                code: item.code || item.name || String(item._internalId),
                displayValue: item.name || item.code || String(item._internalId)
              };
              lookupMap.set(lookup.id, lookup);
              if (item.code) lookupMap.set(item.code, lookup);
            }
            console.log(`[STEP 4] ✓ Found ${refResult._results.length} reference values from ${refObject}`);
            return lookupMap;
          }
        } catch (e) {
          console.log(`[STEP 4] Could not fetch from ${refObject}: ${e}`);
        }
      }
    }
    
    // Method 2: Try to get from describeAttributes with lookup values
    const attrUrl = `/describeAttributes?filter=((resourceName = '${objectName}') and (apiName = '${attributeName}'))&limit=1`;
    const attrResult = await makeRequest(attrUrl);
    
    if (attrResult._results?.[0]?.lookupValues) {
      const values = attrResult._results[0].lookupValues;
      console.log(`[STEP 4] ✓ Found ${values.length} lookup values from describeAttributes`);
      
      for (const lv of values) {
        const lookup: LookupValue = {
          id: String(lv.id || lv.code),
          code: lv.code || String(lv.id),
          displayValue: lv.displayValue || lv.name || lv.code
        };
        lookupMap.set(lookup.id, lookup);
        lookupMap.set(lookup.code, lookup);
      }
      
      return lookupMap;
    }
    
    // Method 3: Try specific lookup endpoint based on lookupType
    if (attributeInfo.lookupType) {
      const lookupType = attributeInfo.lookupType;
      console.log(`[STEP 4] Trying lookup type endpoint: ${lookupType}`);
      
      // Common lookup endpoints
      const lookupEndpoints: Record<string, string> = {
        'SRM_TASK_STATUS': '/lookups/SRM_TASK_STATUS',
        'PROJECT_STATUS': '/lookups/PROJECT_STATUS',
        'INV_INVESTMENT_STATUS': '/lookups/INV_INVESTMENT_STATUS',
        'PRIORITY': '/lookups/PRIORITY',
        'OBS_UNIT_TYPE': '/lookups/OBS_UNIT_TYPE',
        'INV_INVESTMENT_TYPE': '/lookups/INV_INVESTMENT_TYPE',
        'INV_INVESTMENT_STAGE': '/lookups/INV_INVESTMENT_STAGE'
      };
      
      const endpoint = lookupEndpoints[lookupType];
      if (endpoint) {
        try {
          const lookupResult = await makeRequest(`${endpoint}?limit=100`);
          if (lookupResult._results) {
            for (const lv of lookupResult._results) {
              const lookup: LookupValue = {
                id: String(lv._internalId || lv.id || lv.code),
                code: lv.code || lv.uniqueId || String(lv._internalId),
                displayValue: lv.name || lv.displayValue || lv.code
              };
              lookupMap.set(lookup.id, lookup);
              lookupMap.set(lookup.code, lookup);
            }
            console.log(`[STEP 4] ✓ Found ${lookupResult._results.length} lookup values from endpoint`);
            return lookupMap;
          }
        } catch (e) {
          console.log(`[STEP 4] Lookup endpoint ${endpoint} not available`);
        }
      }
      
      // Try generic lookup endpoint
      try {
        const genericResult = await makeRequest(`/lookups/${lookupType}?limit=100`);
        if (genericResult._results) {
          for (const lv of genericResult._results) {
            const lookup: LookupValue = {
              id: String(lv._internalId || lv.id || lv.code),
              code: lv.code || String(lv._internalId),
              displayValue: lv.name || lv.displayValue || lv.code
            };
            lookupMap.set(lookup.id, lookup);
            if (lv.code) lookupMap.set(lv.code, lookup);
          }
          console.log(`[STEP 4] ✓ Found ${genericResult._results.length} lookup values from generic endpoint`);
          return lookupMap;
        }
      } catch (e) {
        console.log(`[STEP 4] Generic lookup endpoint failed`);
      }
    }
    
    // Method 4: Extract unique values from data itself as fallback
    console.log(`[STEP 4] No predefined lookup values found - will extract from data`);
    
    return lookupMap;
    
  } catch (error) {
    console.error(`[STEP 4] ✗ Failed to fetch lookup values:`, error);
    return lookupMap;
  }
}

// ============================================================================
// STEP 5: AGGREGATE / GROUP BY
// ============================================================================

function aggregateDistribution(
  records: any[],
  groupByField: string,
  attributeInfo: AttributeInfo | undefined,
  lookupValues: Map<string, LookupValue>
): DistributionResult {
  console.log(`\n[STEP 5] Aggregating distribution by: ${groupByField}`);
  
  const counts = new Map<string, { value: string; displayValue: string; count: number }>();
  
  for (const record of records) {
    let rawValue = record[groupByField];
    let valueKey: string;
    let displayValue: string;
    
    // Handle different value formats
    if (rawValue === null || rawValue === undefined) {
      valueKey = '__NULL__';
      displayValue = '(Empty)';
    } else if (typeof rawValue === 'object') {
      // Object format: { id: "1", displayValue: "Active", _type: "lookup" }
      valueKey = String(rawValue.id || rawValue.code || rawValue._internalId || JSON.stringify(rawValue));
      displayValue = rawValue.displayValue || rawValue.name || rawValue.code || valueKey;
    } else {
      valueKey = String(rawValue);
      displayValue = valueKey;
    }
    
    // Try to get better display value from lookup map
    if (lookupValues.has(valueKey)) {
      displayValue = lookupValues.get(valueKey)!.displayValue;
    } else if (lookupValues.has(displayValue)) {
      displayValue = lookupValues.get(displayValue)!.displayValue;
    }
    
    // Group percentComplete into ranges
    if (groupByField === 'percentComplete' && rawValue !== null && rawValue !== undefined) {
      const num = parseFloat(String(rawValue));
      if (!isNaN(num)) {
        if (num === 0) { valueKey = '0'; displayValue = '0% (Not Started)'; }
        else if (num < 25) { valueKey = '1-24'; displayValue = '1-24% (Started)'; }
        else if (num < 50) { valueKey = '25-49'; displayValue = '25-49% (In Progress)'; }
        else if (num < 75) { valueKey = '50-74'; displayValue = '50-74% (Halfway)'; }
        else if (num < 100) { valueKey = '75-99'; displayValue = '75-99% (Almost Done)'; }
        else { valueKey = '100'; displayValue = '100% (Complete)'; }
      }
    }
    
    // Update counts
    if (counts.has(valueKey)) {
      counts.get(valueKey)!.count++;
    } else {
      counts.set(valueKey, { value: valueKey, displayValue, count: 1 });
    }
  }
  
  // Convert to sorted array
  const distribution = Array.from(counts.values())
    .map(item => ({
      ...item,
      percentage: Math.round((item.count / records.length) * 1000) / 10
    }))
    .sort((a, b) => b.count - a.count);
  
  const result: DistributionResult = {
    field: groupByField,
    fieldLabel: attributeInfo?.displayName || groupByField,
    totalRecords: records.length,
    distribution
  };
  
  console.log(`[STEP 5] ✓ Distribution calculated:`);
  distribution.slice(0, 5).forEach(d => {
    console.log(`[STEP 5]   - ${d.displayValue}: ${d.count} (${d.percentage}%)`);
  });
  if (distribution.length > 5) {
    console.log(`[STEP 5]   ... and ${distribution.length - 5} more categories`);
  }
  
  return result;
}

// ============================================================================
// AI AGENT - ENHANCED SYSTEM PROMPT FOR METADATA-FIRST APPROACH
// ============================================================================

async function analyzeUserRequest(message: string): Promise<any> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  
  if (!ANTHROPIC_API_KEY) {
    console.log('[AI] No API key, using fallback');
    return fallbackAnalysis(message);
  }

  // Discover available objects for context
  let objectsContext = '';
  try {
    const customObjResult = await makeRequest('/describe?filter=(isCustom = true) and (isSystem = false)&limit=100');
    if (customObjResult._results) {
      const customObjects = customObjResult._results.map((o: any) => `${o.resourceName} ("${o.label}")`);
      objectsContext = `\n\nAVAILABLE CUSTOM OBJECTS:\n${customObjects.slice(0, 20).join(', ')}`;
    }
  } catch (e) {
    console.log('[AI] Could not fetch custom objects');
  }

  const systemPrompt = `You are a Clarity PPM API expert that creates METADATA-FIRST execution plans.

**EXECUTION FLOW - ALWAYS FOLLOW THIS SEQUENCE:**

For DISTRIBUTION/ANALYTICS queries, generate a plan with these steps:
1. describe_object - Validate the target object exists
2. describe_attributes - Get field metadata, identify lookup fields  
3. fetch_data - Get the actual records with required fields
4. fetch_lookups - (ONLY if groupBy field is a lookup) Get lookup display values
5. aggregate - Group/distribute the data

For SIMPLE queries (count, list), you can skip metadata steps:
1. fetch_data - Just get the data

**STEP TYPES:**

- describe_object: { "step": "describe_object", "objectName": "projects" }
- describe_attributes: { "step": "describe_attributes", "objectName": "projects" }
- fetch_data: { "step": "fetch_data", "objectName": "projects", "fields": [...], "filters": {...}, "limit": 500 }
- fetch_data (child): { "step": "fetch_data", "objectName": "projects", "parentId": "FROM_STEP_1", "childType": "tasks", "fields": [...] }
- fetch_lookups: { "step": "fetch_lookups", "objectName": "projects", "attributeName": "status" }
- aggregate: { "step": "aggregate", "operation": "distribution", "groupBy": "status" }

**IMPORTANT FIELD NAMING:**
- Many fields end with "Id" (e.g., "blueprintId" not "blueprint", "managerId" not "manager")
- When user says "by blueprint" → use "blueprintId"
- When user says "by manager" → try "manager" first (it exists in projects)
- When user says "by status" → use "status"
- When user says "by department" → try "departmentId" or "partition"
- When user says "by category" → try "category" or "categoryId"
- Use describe_attributes step to discover actual field names!

**COMMON OBJECTS:**
- projects, tasks, resources, timesheets, ideas, risks, issues, investments
- Custom: custTaskUpdates, custWorkPlanBudget, etc.

**COMMON FIELDS FOR DISTRIBUTION:**
- status (lookup) - Most common for distribution
- blueprintId (reference) - Project template/blueprint
- manager (reference) - Project manager
- percentComplete (number) - Will be grouped into ranges automatically
- priority (lookup or number)
- partition (reference) - OBS/Department
- investmentType (lookup) - Project type
- stage (lookup) - Project stage

**EXAMPLES:**

Q: "Distribute all projects by status"
A: {
  "steps": [
    { "step": "describe_object", "objectName": "projects" },
    { "step": "describe_attributes", "objectName": "projects" },
    { "step": "fetch_data", "objectName": "projects", "fields": ["_internalId", "name", "status"], "limit": 500 },
    { "step": "fetch_lookups", "objectName": "projects", "attributeName": "status" },
    { "step": "aggregate", "operation": "distribution", "groupBy": "status" }
  ],
  "intent": "project_status_distribution"
}

Q: "Distribute projects by blueprint"
A: {
  "steps": [
    { "step": "describe_object", "objectName": "projects" },
    { "step": "describe_attributes", "objectName": "projects" },
    { "step": "fetch_data", "objectName": "projects", "fields": ["_internalId", "name", "blueprintId"], "limit": 500 },
    { "step": "fetch_lookups", "objectName": "projects", "attributeName": "blueprintId" },
    { "step": "aggregate", "operation": "distribution", "groupBy": "blueprintId" }
  ],
  "intent": "project_blueprint_distribution"
}

Q: "Show task completion breakdown"
A: {
  "steps": [
    { "step": "describe_object", "objectName": "tasks" },
    { "step": "describe_attributes", "objectName": "tasks" },
    { "step": "fetch_data", "objectName": "tasks", "fields": ["_internalId", "name", "percentComplete"], "limit": 500 },
    { "step": "aggregate", "operation": "distribution", "groupBy": "percentComplete" }
  ],
  "intent": "task_completion_distribution"
}

Q: "Distribute tasks by status for project Alpha"
A: {
  "steps": [
    { "step": "fetch_data", "objectName": "projects", "filters": { "name": "Alpha" }, "fields": ["_internalId", "name"], "limit": 1 },
    { "step": "describe_attributes", "objectName": "tasks" },
    { "step": "fetch_data", "objectName": "projects", "parentId": "FROM_STEP_1", "childType": "tasks", "fields": ["_internalId", "name", "status"], "limit": 500 },
    { "step": "fetch_lookups", "objectName": "tasks", "attributeName": "status" },
    { "step": "aggregate", "operation": "distribution", "groupBy": "status" }
  ],
  "intent": "project_task_status_distribution"
}

Q: "How many active projects?"
A: {
  "steps": [
    { "step": "fetch_data", "objectName": "projects", "filters": { "isActive": true }, "fields": ["_internalId"], "limit": 500 }
  ],
  "intent": "count_active_projects"
}

Q: "List all custom objects"
A: {
  "steps": [
    { "step": "describe_custom_objects" }
  ],
  "intent": "list_custom_objects"
}

Q: "hi" or "hello"
A: {
  "steps": [],
  "intent": "greeting"
}
${objectsContext}

**RULES:**
1. For ANY distribution/analytics query → Include describe_object + describe_attributes steps
2. For lookup/reference fields → Include fetch_lookups step
3. For percentComplete → Skip fetch_lookups (we group numerically)
4. Always include _internalId in fields
5. Use limit: 500 for distributions to get complete picture
6. For parent-child queries → Use "parentId": "FROM_STEP_X" syntax
7. When unsure about field name → AI should guess with "Id" suffix (blueprintId, managerId, etc.)

User Query: "${message}"

Respond ONLY with the JSON execution plan.`;

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
        messages: [{ role: 'user', content: systemPrompt }]
      })
    });
    
    if (!response.ok) {
      console.error('[AI] API Error:', response.status);
      return fallbackAnalysis(message);
    }
    
    const data = await response.json() as { content: Array<{ text: string }> };
    const content = data.content[0].text;
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const plan = JSON.parse(jsonMatch[0]);
      console.log('[AI] Generated plan:', JSON.stringify(plan, null, 2));
      return plan;
    }
    
    return fallbackAnalysis(message);
    
  } catch (error) {
    console.error('[AI] Error:', error);
    return fallbackAnalysis(message);
  }
}

function fallbackAnalysis(message: string): any {
  const lower = message.toLowerCase().trim();
  
  // Greetings
  if (/^(hi|hello|hey|שלום|היי)[\s!.?]*$/i.test(lower)) {
    return {
      steps: [],
      message: "Hello! I'm your Clarity AI assistant. Try asking:\n• 'Distribute projects by status'\n• 'Show task completion breakdown'\n• 'How many active projects?'",
      intent: 'greeting'
    };
  }
  
  // Distribution queries
  if (/distribut|breakdown|group.*by|analyz|גרף|התפלגות/i.test(lower)) {
    // Determine object type
    let objectType = 'projects';
    if (/task|משימ/i.test(lower)) objectType = 'tasks';
    if (/resource|משאב/i.test(lower)) objectType = 'resources';
    
    // Determine groupBy field
    let groupBy = 'status';
    
    // For tasks
    if (objectType === 'tasks') {
      if (/status|סטטוס/i.test(lower)) groupBy = 'status';
      else if (/complet|percent|אחוז|השלמה/i.test(lower)) groupBy = 'percentComplete';
      else if (/priority|עדיפות/i.test(lower)) groupBy = 'priority';
      else groupBy = 'status'; // Default for tasks
    }
    
    // For projects
    if (objectType === 'projects') {
      if (/status|סטטוס/i.test(lower)) groupBy = 'status';
      else if (/blueprint|תבנית/i.test(lower)) groupBy = 'blueprintId';
      else if (/partition|מבנה.*ארגוני|obs|אגף/i.test(lower)) groupBy = 'partition';
      else if (/manager|מנהל/i.test(lower)) groupBy = 'manager';
      else if (/type|סוג/i.test(lower)) groupBy = 'investmentType';
      else if (/stage|שלב/i.test(lower)) groupBy = 'stage';
      else groupBy = 'status'; // Default for projects
    }
    
    // Build steps
    const needsLookup = groupBy !== 'percentComplete';
    
    return {
      steps: [
        { step: 'describe_object', objectName: objectType },
        { step: 'describe_attributes', objectName: objectType },
        { step: 'fetch_data', objectName: objectType, fields: ['_internalId', 'name', groupBy], limit: 500 },
        ...(needsLookup ? [{ step: 'fetch_lookups', objectName: objectType, attributeName: groupBy }] : []),
        { step: 'aggregate', operation: 'distribution', groupBy }
      ],
      intent: `${objectType}_${groupBy}_distribution`
    };
  }
  
  // Count queries
  if (/how many|count|כמה/i.test(lower)) {
    if (/project|פרויקט/i.test(lower)) {
      return {
        steps: [
          { step: 'fetch_data', objectName: 'projects', filters: /active|פעיל/i.test(lower) ? { isActive: true } : {}, fields: ['_internalId'], limit: 500 }
        ],
        intent: 'count_projects'
      };
    }
    if (/task|משימ/i.test(lower)) {
      return {
        steps: [
          { step: 'fetch_data', objectName: 'tasks', fields: ['_internalId'], limit: 500 }
        ],
        intent: 'count_tasks'
      };
    }
  }
  
  // List custom objects
  if (/custom.*object|list.*object|אובייקט/i.test(lower)) {
    return {
      steps: [{ step: 'describe_custom_objects' }],
      intent: 'list_custom_objects'
    };
  }
  
  return {
    steps: [],
    message: "I'm not sure how to help with that. Try:\n• 'Distribute projects by status'\n• 'Show task completion breakdown'\n• 'How many active projects?'",
    intent: 'unknown'
  };
}

// ============================================================================
// EXECUTION ENGINE - METADATA-FIRST APPROACH
// ============================================================================

interface ExecutionContext {
  objectDescribe?: ObjectDescribe;
  attributes?: Map<string, AttributeInfo>;
  data?: any[];
  lookupValues?: Map<string, LookupValue>;
  distribution?: DistributionResult;
  stepResults: any[];
}

async function executePlan(plan: any): Promise<any> {
  console.log('\n' + '='.repeat(70));
  console.log('EXECUTING METADATA-FIRST PLAN');
  console.log('='.repeat(70));
  
  // Handle greetings and empty plans
  if (!plan.steps || plan.steps.length === 0) {
    return {
      success: true,
      message: plan.message || "Hello! How can I help you with Clarity PPM?",
      context: { stepResults: [] }
    };
  }
  
  const context: ExecutionContext = {
    stepResults: []
  };
  
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`STEP ${i + 1}/${plan.steps.length}: ${step.step}`);
    console.log('─'.repeat(50));
    
    try {
      switch (step.step) {
        case 'describe_object':
          context.objectDescribe = await describeObject(step.objectName);
          context.stepResults.push({ step: step.step, success: true, data: context.objectDescribe });
          break;
          
        case 'describe_attributes':
          context.attributes = await describeAttributes(step.objectName);
          context.stepResults.push({ step: step.step, success: true, count: context.attributes.size });
          break;
          
        case 'describe_custom_objects':
          const customResult = await makeRequest('/describe?filter=(isCustom = true) and (isSystem = false)&limit=500');
          const customObjects = customResult._results || [];
          context.data = customObjects;
          context.stepResults.push({ step: step.step, success: true, count: customObjects.length, data: customObjects });
          break;
          
        case 'fetch_data':
          // Resolve parentId from previous step if needed
          let parentId = step.parentId;
          if (parentId && parentId.startsWith('FROM_STEP_')) {
            const stepNum = parseInt(parentId.replace('FROM_STEP_', '')) - 1;
            const prevResult = context.stepResults[stepNum];
            if (prevResult?.data?.[0]?._internalId) {
              parentId = prevResult.data[0]._internalId;
            } else if (prevResult?.data?._internalId) {
              parentId = prevResult.data._internalId;
            }
            console.log(`[EXEC] Resolved parentId from step ${stepNum + 1}: ${parentId}`);
          }
          
          // Smart field resolution - try variations if field not found
          let fields = step.fields || ['_internalId', 'name'];
          const originalFields = [...fields];
          const fieldsNotFound: string[] = [];
          
          if (context.attributes && fields.length > 0) {
            const resolvedFields: string[] = [];
            
            // Debug: Show some available fields
            const availableFields = Array.from(context.attributes.values())
              .filter(a => a.apiName && !a.apiName.startsWith('_'))
              .map(a => a.apiName)
              .slice(0, 30);
            console.log(`[EXEC] Sample available fields: ${availableFields.join(', ')}`);
            
            for (const field of fields) {
              if (field === '_internalId' || field === 'name') {
                resolvedFields.push(field);
                continue;
              }
              
              // Check if field exists directly
              if (context.attributes.has(field)) {
                resolvedFields.push(field);
                continue;
              }
              
              // Try with 'Id' suffix (blueprint -> blueprintId)
              const fieldWithId = field + 'Id';
              if (context.attributes.has(fieldWithId)) {
                console.log(`[EXEC] Field "${field}" not found, using "${fieldWithId}" instead`);
                resolvedFields.push(fieldWithId);
                // Update the aggregate step's groupBy field too
                const aggregateStep = plan.steps.find((s: any) => s.step === 'aggregate');
                if (aggregateStep && aggregateStep.groupBy === field) {
                  aggregateStep.groupBy = fieldWithId;
                  console.log(`[EXEC] Updated aggregate groupBy to "${fieldWithId}"`);
                }
                // Update fetch_lookups step too
                const lookupStep = plan.steps.find((s: any) => s.step === 'fetch_lookups' && s.attributeName === field);
                if (lookupStep) {
                  lookupStep.attributeName = fieldWithId;
                  console.log(`[EXEC] Updated fetch_lookups attributeName to "${fieldWithId}"`);
                }
                continue;
              }
              
              // Try without 'Id' suffix (statusId -> status)
              const fieldWithoutId = field.replace(/Id$/, '');
              if (fieldWithoutId !== field && context.attributes.has(fieldWithoutId)) {
                console.log(`[EXEC] Field "${field}" not found, using "${fieldWithoutId}" instead`);
                resolvedFields.push(fieldWithoutId);
                continue;
              }
              
              // Try case-insensitive and partial match
              let foundMatch = false;
              const lowerField = field.toLowerCase();
              
              for (const [attrName, attrInfo] of context.attributes.entries()) {
                if (!attrInfo.apiName) continue;
                
                // Case-insensitive exact match
                if (attrInfo.apiName.toLowerCase() === lowerField) {
                  console.log(`[EXEC] Field "${field}" found as "${attrInfo.apiName}" (case-insensitive)`);
                  resolvedFields.push(attrInfo.apiName);
                  foundMatch = true;
                  break;
                }
              }
              
              if (!foundMatch) {
                // Try partial match - field name contains search term
                for (const [attrName, attrInfo] of context.attributes.entries()) {
                  if (!attrInfo.apiName) continue;
                  
                  if (attrInfo.apiName.toLowerCase().includes(lowerField) || 
                      lowerField.includes(attrInfo.apiName.toLowerCase())) {
                    console.log(`[EXEC] Field "${field}" not found, found similar: "${attrInfo.apiName}"`);
                    resolvedFields.push(attrInfo.apiName);
                    // Update other steps
                    const aggregateStep = plan.steps.find((s: any) => s.step === 'aggregate');
                    if (aggregateStep && aggregateStep.groupBy === field) {
                      aggregateStep.groupBy = attrInfo.apiName;
                    }
                    const lookupStep = plan.steps.find((s: any) => s.step === 'fetch_lookups' && s.attributeName === field);
                    if (lookupStep) {
                      lookupStep.attributeName = attrInfo.apiName;
                    }
                    foundMatch = true;
                    break;
                  }
                }
              }
              
              // If still not found, add to not found list but TRY ANYWAY
              // Some fields might be accessible but not in describeAttributes
              if (!foundMatch) {
                console.warn(`[EXEC] ⚠ Field "${field}" not found in metadata - will try anyway`);
                fieldsNotFound.push(field);
                resolvedFields.push(field); // Try it anyway!
              }
            }
            
            fields = resolvedFields.length > 0 ? resolvedFields : ['_internalId', 'name'];
          }
          
          console.log(`[EXEC] Final fields: ${fields.join(', ')}`);
          
          // Try to fetch with all fields first
          let records: any[] = [];
          try {
            records = await fetchData({
              objectName: step.objectName,
              parentId: parentId,
              childType: step.childType,
              fields: fields,
              filters: step.filters,
              limit: step.limit || 500
            });
          } catch (fetchError) {
            // If fetch fails with certain fields, try without the problematic ones
            if (fieldsNotFound.length > 0) {
              console.log(`[EXEC] Fetch failed, retrying without unverified fields: ${fieldsNotFound.join(', ')}`);
              const safeFields = fields.filter(f => !fieldsNotFound.includes(f));
              if (safeFields.length === 0) safeFields.push('_internalId', 'name');
              
              records = await fetchData({
                objectName: step.objectName,
                parentId: parentId,
                childType: step.childType,
                fields: safeFields,
                filters: step.filters,
                limit: step.limit || 500
              });
            } else {
              throw fetchError;
            }
          }
          
          context.data = records;
          context.stepResults.push({ step: step.step, success: true, count: records.length, data: records });
          break;
          
        case 'fetch_lookups':
          const attrInfo = context.attributes?.get(step.attributeName);
          if (attrInfo) {
            context.lookupValues = await fetchLookupValues(
              step.objectName, 
              step.attributeName, 
              attrInfo
            );
          } else {
            context.lookupValues = new Map();
            console.log(`[EXEC] Attribute ${step.attributeName} not found in metadata, skipping lookup fetch`);
          }
          context.stepResults.push({ step: step.step, success: true, count: context.lookupValues.size / 2 });
          break;
          
        case 'aggregate':
          if (!context.data || context.data.length === 0) {
            throw new Error('No data to aggregate');
          }
          
          const attrInfoForAgg = context.attributes?.get(step.groupBy);
          context.distribution = aggregateDistribution(
            context.data,
            step.groupBy,
            attrInfoForAgg,
            context.lookupValues || new Map()
          );
          context.stepResults.push({ step: step.step, success: true, distribution: context.distribution });
          break;
          
        default:
          console.warn(`[EXEC] Unknown step type: ${step.step}`);
          context.stepResults.push({ step: step.step, success: false, error: 'Unknown step type' });
      }
      
    } catch (error) {
      console.error(`[EXEC] Step ${i + 1} failed:`, error);
      context.stepResults.push({ 
        step: step.step, 
        success: false, 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('EXECUTION COMPLETE');
  console.log('='.repeat(70));
  
  return {
    success: true,
    context,
    plan
  };
}

// ============================================================================
// FORMAT RESPONSE
// ============================================================================

async function formatResponse(execution: any): Promise<{ reply: string; data: any }> {
  // Handle greetings
  if (execution.message) {
    return { reply: execution.message, data: null };
  }
  
  const context: ExecutionContext = execution.context;
  const intent = execution.plan?.intent || '';
  
  // Distribution response
  if (context.distribution) {
    const dist = context.distribution;
    let reply = `📊 **${dist.fieldLabel} Distribution** (${dist.totalRecords} records)\n\n`;
    
    dist.distribution.forEach((item, i) => {
      const bar = '█'.repeat(Math.max(1, Math.round(item.percentage / 5)));
      reply += `${item.displayValue}\n${bar} ${item.count} (${item.percentage}%)\n\n`;
    });
    
    return {
      reply,
      data: {
        _type: 'distribution',
        _totalCount: dist.totalRecords,
        _results: context.data,
        _distribution: dist.distribution
      }
    };
  }
  
  // Custom objects list
  if (intent.includes('custom_objects') && context.data) {
    let reply = `📋 **Custom Objects** (${context.data.length} found)\n\n`;
    
    const items = context.data.slice(0, 20).map((obj: any, i: number) => {
      return `${i + 1}. **${obj.label || obj.resourceName}** (${obj.resourceName})`;
    });
    
    reply += items.join('\n');
    
    if (context.data.length > 20) {
      reply += `\n\n_...and ${context.data.length - 20} more_`;
    }
    
    return { reply, data: { _results: context.data, _totalCount: context.data.length } };
  }
  
  // Count response
  if (intent.includes('count') && context.data) {
    const objectName = execution.plan?.steps?.[0]?.objectName || 'records';
    return {
      reply: `📊 **Found ${context.data.length} ${objectName}**`,
      data: { _results: context.data, _totalCount: context.data.length }
    };
  }
  
  // List response
  if (context.data && context.data.length > 0) {
    const objectName = context.objectDescribe?.label || execution.plan?.steps?.[0]?.objectName || 'records';
    let reply = `✅ **Found ${context.data.length} ${objectName}**\n\n`;
    
    const items = context.data.slice(0, 15).map((item: any, i: number) => {
      const name = item.name || item.code || item._internalId;
      const status = item.status?.displayValue || item.status || '';
      return `${i + 1}. **${name}**${status ? ` (${status})` : ''}`;
    });
    
    reply += items.join('\n');
    
    if (context.data.length > 15) {
      reply += `\n\n_...and ${context.data.length - 15} more_`;
    }
    
    return { reply, data: { _results: context.data, _totalCount: context.data.length } };
  }
  
  return { reply: '❌ No results found', data: null };
}

// ============================================================================
// ROUTES
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    version: '5.0.0-metadata-first',
    approach: 'Metadata-First Analytics',
    config: {
      baseUrl: config.baseUrl,
      hasAuth: !!(config.username || config.sessionId || config.authToken),
      hasAI: !!process.env.ANTHROPIC_API_KEY
    }
  });
});

app.post('/api/chat', async (req, res) => {
  const { message, clarityBaseUrl, claritySessionId } = req.body;
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`[CHAT] User: "${message}"`);
  console.log('═'.repeat(70));
  
  if (clarityBaseUrl) config.baseUrl = clarityBaseUrl;
  if (claritySessionId) {
    config.sessionId = claritySessionId;
    config.username = undefined;
    config.password = undefined;
  }
  
  try {
    // Step 1: Analyze request and generate execution plan
    const plan = await analyzeUserRequest(message);
    
    // Step 2: Execute the metadata-first plan
    const execution = await executePlan(plan);
    
    // Step 3: Format response
    const { reply, data } = await formatResponse(execution);
    
    res.json({
      success: true,
      reply,
      data,
      _debug: { plan, stepResults: execution.context?.stepResults },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[CHAT] Error:', error);
    res.json({
      success: false,
      reply: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date().toISOString()
    });
  }
});

// Discovery endpoint
app.get('/api/discover', async (req, res) => {
  try {
    const customResult = await makeRequest('/describe?filter=(isCustom = true) and (isSystem = false)&limit=500');
    const allResult = await makeRequest('/describe?limit=500');
    
    res.json({
      success: true,
      customObjects: customResult._results || [],
      allObjects: allResult._results || [],
      customCount: customResult._totalCount || 0,
      totalCount: allResult._totalCount || 0
    });
  } catch (error) {
    res.json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

// Metadata endpoint
app.get('/api/metadata/:objectName', async (req, res) => {
  try {
    const { objectName } = req.params;
    
    const describe = await describeObject(objectName);
    const attributes = await describeAttributes(objectName);
    
    res.json({
      success: true,
      describe,
      attributes: Array.from(attributes.values()),
      attributeCount: attributes.size
    });
  } catch (error) {
    res.json({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('🚀 Clarity PPM Server v5.0.0 - METADATA-FIRST ANALYTICS');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔗 Base URL: ${config.baseUrl}`);
  console.log(`🔐 Auth: ${config.username ? 'Basic' : config.sessionId ? 'Session' : config.authToken ? 'Token' : 'None'}`);
  console.log(`🤖 AI: ${process.env.ANTHROPIC_API_KEY ? 'Enabled' : 'Disabled'}`);
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('EXECUTION FLOW:');
  console.log('  1. Describe Object    → Validate object exists');
  console.log('  2. Describe Attributes → Get field metadata');
  console.log('  3. Fetch Data         → Get actual records');
  console.log('  4. Fetch Lookups      → Get lookup display values');
  console.log('  5. Aggregate          → Group/distribute data');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Chat:   POST http://localhost:${PORT}/api/chat`);
  console.log('══════════════════════════════════════════════════════════════════════');
});
