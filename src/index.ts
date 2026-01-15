/**
 * Clarity PPM HTTP Server v3.0.0 - Dynamic Swagger Edition
 * Capability: Can call ANY endpoint defined in Clarity Swagger without hardcoding tools
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
// GENERIC HTTP CLIENT
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
// CACHING
// ============================================================================

const schemaCache = new Map<string, any>();

async function getObjectSchema(objectName: string): Promise<any> {
  if (schemaCache.has(objectName)) {
    console.log(`[Cache] Using cached schema for ${objectName}`);
    return schemaCache.get(objectName);
  }

  try {
    const cleanName = objectName.replace(/[^a-zA-Z0-9_]/g, '');
    const result = await makeRequest(`/describeAttributes?filter=(resourceName='${cleanName}')`);
    
    if (!result._results || result._results.length === 0) {
      console.warn(`[Schema] No attributes found for ${objectName}, using fallback`);
      return {
        _results: [
          { apiName: '_internalId', dataType: 'number' },
          { apiName: 'name', dataType: 'string' },
          { apiName: 'code', dataType: 'string' }
        ],
        _fallback: true
      };
    }

    schemaCache.set(objectName, result);
    console.log(`[Schema] Cached ${result._results.length} fields for ${objectName}`);
    return result;
  } catch (error) {
    console.error(`[Schema] Error for ${objectName}:`, error);
    return {
      _results: [
        { apiName: '_internalId', dataType: 'number' },
        { apiName: 'name', dataType: 'string' }
      ],
      _fallback: true
    };
  }
}

// ============================================================================
// SIMPLE PATTERN MATCHER (Fallback)
// ============================================================================

function simplePatternMatch(message: string): any {
  const lower = message.toLowerCase();
  
  // Greetings
  if (/^(hi|hello|hey)$/i.test(lower.trim())) {
    return {
      steps: [],
      message: "👋 Hello! I can help you query Clarity PPM. Try asking 'how many projects' or 'show active projects'",
      intent: "greeting"
    };
  }
  
  // Count projects
  if (/how many.*project/i.test(lower)) {
    return {
      steps: [
        {
          tool: "get_schema",
          params: { objectName: "projects" },
          reason: "Learn project schema"
        },
        {
          tool: "call_endpoint",
          params: {
            path: "/projects",
            query: { fields: "_internalId", limit: 500 }
          },
          reason: "Count all projects"
        }
      ],
      intent: "count_projects"
    };
  }
  
  // List active projects
  if (/(show|list).*active.*project/i.test(lower)) {
    return {
      steps: [
        {
          tool: "get_schema",
          params: { objectName: "projects" },
          reason: "Learn project schema"
        },
        {
          tool: "call_endpoint",
          params: {
            path: "/projects",
            query: {
              filter: "(isActive=true)",
              fields: "FIELDS_FROM_STEP_1",
              limit: 50
            }
          },
          reason: "List active projects"
        }
      ],
      intent: "list_projects"
    };
  }
  
  // Count resources
  if (/how many.*resource/i.test(lower)) {
    return {
      steps: [
        {
          tool: "get_schema",
          params: { objectName: "resources" },
          reason: "Learn resource schema"
        },
        {
          tool: "call_endpoint",
          params: {
            path: "/resources",
            query: { fields: "_internalId", limit: 500 }
          },
          reason: "Count all resources"
        }
      ],
      intent: "count_resources"
    };
  }
  
  return {
    steps: [],
    message: "I'm not sure how to help with that. Try 'how many projects' or 'show active projects'",
    intent: "unknown"
  };
}

// ============================================================================
// AI AGENT: DYNAMIC SWAGGER LOGIC
// ============================================================================

async function analyzeIntentWithClaude(message: string, history: any[]): Promise<any> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  
  // Simple fallback patterns if no AI key
  if (!ANTHROPIC_API_KEY) {
    console.log('[AI] No API key, using simple patterns');
    return simplePatternMatch(message);
  }

  // Comprehensive Swagger-aware system prompt
  const systemPrompt = `You are a Clarity PPM API Expert. You construct REST API calls dynamically based on Clarity Swagger patterns.

**SWAGGER KNOWLEDGE BASE:**

**Top-Level Objects (Direct Access):**
/projects, /resources, /ideas, /risks, /issues, /timesheets, /users, /objectives
/costPlans, /benefitPlans, /actualTransactions, /unpostedTransactions, /vouchers
/agreements, /allocations, /skills, /hierarchies, /scenarios, /roadmaps

**Child Objects (Parent/{id}/Child):**
/projects/{id}/tasks, /projects/{id}/teams, /projects/{id}/risks, /projects/{id}/issues
/projects/{id}/changes, /projects/{id}/projectStatusReports, /projects/{id}/baselines
/timesheets/{id}/timeEntries, /timesheets/{id}/notes
/roadmaps/{id}/roadmapItems, /roadmapItems/{id}/itemEvents
/objectives/{id}/keyResults, /keyResults/{id}/actualValues
/costPlans/{id}/costPlanDetails, /benefitPlans/{id}/benefitPlanDetails

**Task Sub-Resources:**
/projects/{projectId}/tasks/{taskId}/assignments
/projects/{projectId}/tasks/{taskId}/taskDependencies
/projects/{projectId}/tasks/{taskId}/todos

**Lookup Values:**
/lookups/{lookupType}/lookupValues
Examples: /lookups/BROWSE_PROJMGR/lookupValues, /lookups/INV_IDEA_STATUS/lookupValues

**Metadata:**
/describeAttributes?filter=(resourceName='{objectName}')

**EXECUTION STRATEGY:**

**For "List" Queries (e.g., "Show me active projects"):**
Step 1: get_schema(objectName) - Discover available fields
Step 2: call_endpoint(path="/projects", query={filter: "(isActive=true)", fields: "FIELDS_FROM_STEP_1"})

**For "Child Object" Queries (e.g., "Show risks for project Alpha"):**
Step 1: get_schema("projects") - Learn project schema
Step 2: call_endpoint(path="/projects", query={filter: "(name='Alpha')", fields: "_internalId,name"})
Step 3: get_schema("risks") - Learn risk schema  
Step 4: call_endpoint(path="/projects/ID_FROM_STEP_2/risks", query={fields: "FIELDS_FROM_STEP_3"})

**For "Count" Queries (e.g., "How many timesheets"):**
Step 1: get_schema("timesheets")
Step 2: call_endpoint(path="/timesheets", query={fields: "_internalId", limit: 500})

**For "Create/Update" Queries:**
Step 1: get_schema(objectName) - Learn required fields
Step 2: call_endpoint(path="/projects", method="POST", body={...})

**AVAILABLE TOOLS:**

1. **get_schema**
   - objectName: string (e.g., "projects", "risks", "timesheets")
   - reason: string (why discovering schema)

2. **call_endpoint**
   - path: string (e.g., "/projects", "/projects/5001/tasks")
   - method: "GET" | "POST" | "PATCH" | "DELETE" (default: GET)
   - query: object (e.g., {filter: "(isActive=true)", fields: "name,code", limit: 50})
   - body: object (for POST/PATCH)
   - reason: string (why calling this endpoint)

**PLACEHOLDERS:**
- "FIELDS_FROM_STEP_X" - Extract field names from schema in step X
- "ID_FROM_STEP_X" - Extract _internalId from result in step X
- "ALL_IDS_FROM_STEP_X" - Extract array of all _internalId values from step X

**CRITICAL RULES:**
1. ALWAYS call get_schema BEFORE querying an object
2. Use "_internalId" for IDs (never "id")
3. For counts: fields="_internalId" only
4. For lists: fields extracted from schema (max 10 fields)
5. Parent-child relationships: Get parent ID first, then query child
6. Filter syntax: (fieldName = 'value') with spaces around operator
7. Maximum limit: 500

**EXAMPLES:**

Q: "How many active projects?"
A: {
  "steps": [
    {"tool": "get_schema", "params": {"objectName": "projects"}, "reason": "Learn project schema"},
    {"tool": "call_endpoint", "params": {"path": "/projects", "query": {"filter": "(isActive=true)", "fields": "_internalId", "limit": 500}}, "reason": "Count active projects"}
  ],
  "intent": "count_projects"
}

Q: "Show me risks for project 'Alpha'"
A: {
  "steps": [
    {"tool": "get_schema", "params": {"objectName": "projects"}, "reason": "Learn project schema"},
    {"tool": "call_endpoint", "params": {"path": "/projects", "query": {"filter": "(name='Alpha')", "fields": "_internalId,name"}}, "reason": "Find project ID"},
    {"tool": "get_schema", "params": {"objectName": "risks"}, "reason": "Learn risk schema"},
    {"tool": "call_endpoint", "params": {"path": "/projects/ID_FROM_STEP_2/risks", "query": {"fields": "FIELDS_FROM_STEP_3", "limit": 50}}, "reason": "Get project risks"}
  ],
  "intent": "list_risks"
}

Q: "List submitted timesheets"
A: {
  "steps": [
    {"tool": "get_schema", "params": {"objectName": "timesheets"}, "reason": "Learn timesheet schema"},
    {"tool": "call_endpoint", "params": {"path": "/timesheets", "query": {"filter": "(status='SUBMITTED')", "fields": "FIELDS_FROM_STEP_1", "limit": 50}}, "reason": "Query submitted timesheets"}
  ],
  "intent": "list_timesheets"
}

Q: "Show me time entries for timesheet 5001000"
A: {
  "steps": [
    {"tool": "get_schema", "params": {"objectName": "timeEntries"}, "reason": "Learn time entry schema"},
    {"tool": "call_endpoint", "params": {"path": "/timesheets/5001000/timeEntries", "query": {"fields": "FIELDS_FROM_STEP_1"}}, "reason": "Get time entries"}
  ],
  "intent": "list_time_entries"
}

User Query: "${message}"

Respond with a JSON execution plan only. No explanations.`;

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
          ...history.slice(-3),
          { role: 'user', content: systemPrompt }
        ]
      })
    });
    
    if (!response.ok) {
      console.error('[AI] API Error:', response.status);
      return simplePatternMatch(message);
    }
    
    const data = await response.json();
    const content = data.content[0].text;
    console.log('[AI] Raw response:', content.substring(0, 200));
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const plan = JSON.parse(jsonMatch[0]);
      console.log('[AI] Parsed plan with', plan.steps?.length || 0, 'steps');
      return plan;
    }
    
    console.warn('[AI] Could not parse JSON, using fallback');
    return simplePatternMatch(message);
    
  } catch (error) {
    console.error('[AI] Error:', error);
    return simplePatternMatch(message);
  }
}

// ============================================================================
// EXECUTION ENGINE
// ============================================================================

async function executeplan(plan: any): Promise<any> {
  if (!plan.steps || !Array.isArray(plan.steps)) {
    throw new Error('Invalid plan: missing steps array');
  }

  let context: any = {};
  let finalResult: any = null;
  
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const stepNum = i + 1;
    console.log(`\n[Step ${stepNum}] ${step.tool}: ${step.reason}`);
    
    try {
      let params = JSON.parse(JSON.stringify(step.params || {}));
      
      // Replace ID placeholders
      Object.keys(params).forEach(key => {
        const value = params[key];
        
        // Single ID: ID_FROM_STEP_X
        if (typeof value === 'string' && value.startsWith('ID_FROM_STEP_')) {
          const sourceStep = parseInt(value.split('_')[3]);
          const sourceResult = context[`step${sourceStep}`];
          if (sourceResult?._results?.[0]?._internalId) {
            params[key] = sourceResult._results[0]._internalId;
            console.log(`[Replaced] ${value} → ${params[key]}`);
          }
        }
        
        // Array of IDs: ALL_IDS_FROM_STEP_X
        if (typeof value === 'string' && value.includes('ALL_IDS_FROM_STEP_')) {
          const sourceStep = parseInt(value.split('_')[4]);
          const sourceResult = context[`step${sourceStep}`];
          if (sourceResult?._results) {
            params[key] = sourceResult._results.map((r: any) => r._internalId).filter(Boolean);
            console.log(`[Replaced] ${value} → ${params[key].length} IDs`);
          }
        }
        
        // Fields from schema: FIELDS_FROM_STEP_X
        const isFieldPlaceholder = (typeof value === 'string' && value.includes('FIELDS_FROM_STEP_')) ||
                                  (Array.isArray(value) && value[0]?.includes('FIELDS_FROM_STEP_'));
        
        if (isFieldPlaceholder) {
          const valStr = Array.isArray(value) ? value[0] : value;
          const sourceStep = parseInt(valStr.split('_')[3]);
          const sourceResult = context[`step${sourceStep}`];
          
          if (sourceResult?._results) {
            const schema = sourceResult._results;
            const isCountQuery = plan.intent?.startsWith('count_');
            
            if (isCountQuery) {
              params[key] = ['_internalId'];
            } else {
              const fields = schema
                .filter((f: any) => {
                  const name = f.apiName || f.name || '';
                  return name !== 'attachment' && (!name.startsWith('_') || name === '_internalId');
                })
                .slice(0, 10)
                .map((f: any) => f.apiName || f.name)
                .filter(Boolean);
              
              if (!fields.includes('_internalId')) fields.unshift('_internalId');
              if (!fields.includes('name') && schema.some((f: any) => f.apiName === 'name')) {
                fields.splice(1, 0, 'name');
              }
              
              params[key] = fields;
            }
            console.log(`[Replaced] ${valStr} → ${params[key].join(',')}`);
          }
        }
        
        // Replace IDs in path: /projects/ID_FROM_STEP_2/risks
        if (key === 'path' && typeof params[key] === 'string') {
          params[key] = params[key].replace(/ID_FROM_STEP_(\d+)/g, (match: string, stepNumStr: string) => {
            const sourceStep = parseInt(stepNumStr);
            const sourceResult = context[`step${sourceStep}`];
            const id = sourceResult?._results?.[0]?._internalId;
            console.log(`[Replaced in path] ${match} → ${id}`);
            return id || match;
          });
        }
      });
      
      // Execute tool
      let result: any;
      
      if (step.tool === 'get_schema') {
        result = await getObjectSchema(params.objectName);
        
      } else if (step.tool === 'call_endpoint') {
        let path = params.path;
        let queryStr = '';
        
        if (params.query) {
          const queryParams = new URLSearchParams();
          Object.entries(params.query).forEach(([k, v]: [string, any]) => {
            if (Array.isArray(v)) {
              queryParams.append(k, v.join(','));
            } else {
              queryParams.append(k, String(v));
            }
          });
          queryStr = `?${queryParams.toString()}`;
        }
        
        result = await makeRequest(path + queryStr, params.method || 'GET', params.body);
      }
      
      context[`step${stepNum}`] = result;
      finalResult = result;
      
      console.log(`[Step ${stepNum}] Result: ${result._totalCount || result._results?.length || 'N/A'} records`);
      
    } catch (error) {
      console.error(`[Step ${stepNum}] Failed:`, error);
      throw new Error(`Step ${stepNum} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  return { finalResult, context, plan };
}

// ============================================================================
// FORMAT RESPONSE
// ============================================================================

function formatResponse(result: any, plan: any): string {
  const count = result._totalCount || result._results?.length || 0;
  const intent = plan.intent || '';
  
  // Count queries
  if (intent.startsWith('count_')) {
    const objectType = intent.replace('count_', '').replace('_', ' ');
    return `📊 **Found ${count} ${objectType}**`;
  }
  
  // List queries
  if (count === 0) {
    return `❌ No results found`;
  }
  
  let reply = `✅ **Found ${count} records**\n\n`;
  
  if (result._results && result._results.length > 0) {
    const items = result._results.slice(0, 15).map((item: any, i: number) => {
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
    version: '3.0.0-swagger-dynamic',
    config: {
      baseUrl: config.baseUrl,
      hasAuth: !!(config.username || config.sessionId || config.authToken),
      hasAI: !!process.env.ANTHROPIC_API_KEY
    }
  });
});

app.post('/api/chat', async (req, res) => {
  const { message, conversationHistory, clarityBaseUrl, claritySessionId } = req.body;
  
  console.log(`\n[Chat] User: "${message}"`);
  
  // Override config dynamically
  if (clarityBaseUrl) config.baseUrl = clarityBaseUrl;
  if (claritySessionId) {
    config.sessionId = claritySessionId;
    config.username = undefined;
    config.password = undefined;
  }
  
  try {
    const plan = await analyzeIntentWithClaude(message, conversationHistory || []);
    
    console.log('[Chat] Received plan:', JSON.stringify(plan, null, 2));
    
    // Check for errors in plan generation
    if (plan.action === 'error' || plan.error) {
      return res.json({
        success: false,
        reply: `❌ AI Error: ${plan.message || plan.error || 'Unknown error'}`,
        timestamp: new Date().toISOString()
      });
    }
    
    // Handle greetings and empty plans
    if (!plan.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      return res.json({
        success: true,
        reply: plan.message || "👋 Hello! I can query ANY Clarity PPM object dynamically. Just ask naturally!",
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`[Chat] Executing ${plan.steps.length} steps...`);
    
    const { finalResult, context, plan: executedPlan } = await executeplan(plan);
    const reply = formatResponse(finalResult, executedPlan);
    
    res.json({
      success: true,
      reply,
      data: finalResult,
      _debug: { plan: executedPlan, stepsExecuted: plan.steps.length },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[Chat] Error:', error);
    res.json({
      success: false,
      reply: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
      _debug: { error: String(error) },
      timestamp: new Date().toISOString()
    });
  }
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
  console.log('🚀 Clarity PPM Dynamic Swagger Server v3.0.0');
  console.log(`📡 Listening on port ${PORT}`);
  console.log(`🔗 Base URL: ${config.baseUrl}`);
  console.log(`🔐 Auth: ${config.username ? 'Basic' : config.sessionId ? 'Session' : config.authToken ? 'Token' : 'None'}`);
  console.log(`🤖 AI Agent: ${process.env.ANTHROPIC_API_KEY ? 'Enabled' : 'Disabled'}`);
  console.log('======================================================================');
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Chat: POST http://localhost:${PORT}/api/chat`);
  console.log('======================================================================');
});
