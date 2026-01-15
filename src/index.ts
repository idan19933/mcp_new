/**
 * Clarity PPM HTTP Server
 * Version 2.0.0 - Complete Edition
 * 
 * Full-featured HTTP wrapper with all 17 tools from MCP server
 * For Railway deployment with browser extension support
 */

import express, { Request, Response, NextFunction } from 'express';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

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

// Store request-specific Clarity config
const requestConfigs = new Map();

// Simple CORS middleware (no external dependency)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================================================
// CACHING
// ============================================================================

const cachedObjects = new Map<string, any>();
const cachedAttributes = new Map<string, any>();
const cachedLookups = new Map<string, any>();

// ============================================================================
// HTTP CLIENT
// ============================================================================

async function makeRequest(
  endpoint: string,
  method: string = 'GET',
  body?: any,
  headers: Record<string, string> = {}
): Promise<any> {
  const url = `${config.baseUrl}/ppm/rest/v1${endpoint}`;

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...headers,
  };

  if (config.authToken) {
    requestHeaders['authtoken'] = config.authToken;
  } else if (config.username && config.password) {
    const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    requestHeaders['Authorization'] = `Basic ${auth}`;
  } else if (config.sessionId) {
    // sessionId might be entire cookie string from browser
    requestHeaders['Cookie'] = config.sessionId;
  }

  const options: RequestInit = {
    method,
    headers: requestHeaders,
  };

  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  console.log(`[Clarity API] ${method} ${url}`);
  console.log(`[Clarity API] Using config.baseUrl: ${config.baseUrl}`);
  console.log(`[Clarity API] Using config.sessionId: ${config.sessionId ? 'YES' : 'NO'}`);

  try {
    const response = await fetch(url, options);
    const text = await response.text();

    if (!response.ok) {
      console.error(`[Clarity API] Error ${response.status}: ${text.substring(0, 200)}`);
      throw new Error(`Clarity API returned ${response.status}. URL was: ${url}`);
    }

    return text ? JSON.parse(text) : null;
  } catch (error) {
    console.error(`[Clarity API] Request failed:`, error);
    throw error;
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function encodeFilter(filter: string): string {
  if (!filter) return '';
  return filter
    .replace(/\s+/g, '+')
    .replace(/=/g, '%3D')
    .replace(/'/g, '%27')
    .replace(/"/g, '%27')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

const pluralMap: Record<string, string> = {
  project: 'projects',
  task: 'tasks',
  resource: 'resources',
  idea: 'ideas',
  objective: 'objectives',
  risk: 'risks',
  issue: 'issues',
  change: 'changes',
  team: 'teams',
  assignment: 'assignments',
  timesheet: 'timesheets',
  baseline: 'baselines',
  roadmap: 'roadmaps',
  scenario: 'scenarios',
  costPlan: 'costPlans',
  benefitPlan: 'benefitPlans',
};

function pluralize(objectName: string): string {
  const lower = objectName.toLowerCase();
  return pluralMap[lower] || objectName;
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

async function handleGetObjects(): Promise<any> {
  if (cachedObjects.size > 0) {
    console.log('[Cache] Using cached objects list');
    return Array.from(cachedObjects.values());
  }

  const endpoint = `/describe?filter=((extensions+in+('inv')))`;
  const result = await makeRequest(endpoint);

  if (result._results) {
    result._results.forEach((obj: any) => {
      cachedObjects.set(obj.resourceName, obj);
    });
  }

  return result;
}

async function handleGetObjectAttributes(objectName: string): Promise<any> {
  if (cachedAttributes.has(objectName)) {
    console.log(`[Cache] Using cached attributes for ${objectName}`);
    return cachedAttributes.get(objectName);
  }

  const endpoint = `/describeAttributes?filter=(resourceName+%3D+%27${objectName}%27)`;
  const result = await makeRequest(endpoint);

  cachedAttributes.set(objectName, result);
  console.log(`[Cache] Stored attributes for ${objectName}`);

  return result;
}

async function handleQueryObject(args: {
  objectName: string;
  fields: string[];
  filter?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}): Promise<any> {
  const objectPath = pluralize(args.objectName);
  const fieldsParam = args.fields.join(',');

  let endpoint = `/${objectPath}?fields=${fieldsParam}`;

  if (args.filter) endpoint += `&filter=${encodeFilter(args.filter)}`;
  if (args.limit) endpoint += `&limit=${args.limit}`;
  if (args.offset) endpoint += `&offset=${args.offset}`;
  if (args.sort) endpoint += `&sort=${args.sort}`;

  return await makeRequest(endpoint);
}

async function handleGetProjectTasks(args: {
  projectId: number;
  fields: string[];
  filter?: string;
  limit?: number;
}): Promise<any> {
  const fieldsParam = args.fields.join(',');
  let endpoint = `/projects/${args.projectId}/tasks?fields=${fieldsParam}`;

  if (args.filter) endpoint += `&filter=${encodeFilter(args.filter)}`;
  if (args.limit) endpoint += `&limit=${args.limit}`;

  return await makeRequest(endpoint);
}

async function handleGetProjectTeams(args: {
  projectId: number;
  fields: string[];
  filter?: string;
}): Promise<any> {
  const fieldsParam = args.fields.join(',');
  let endpoint = `/projects/${args.projectId}/teams?fields=${fieldsParam}`;

  if (args.filter) endpoint += `&filter=${encodeFilter(args.filter)}`;

  return await makeRequest(endpoint);
}

async function handleGetTaskAssignments(args: {
  projectId: number;
  taskId: number;
  fields: string[];
}): Promise<any> {
  const fieldsParam = args.fields.join(',');
  const endpoint = `/projects/${args.projectId}/tasks/${args.taskId}/assignments?fields=${fieldsParam}`;

  return await makeRequest(endpoint);
}

async function handleGetLookupValues(args: {
  lookupType: string;
  filter?: string;
}): Promise<any> {
  const cacheKey = `${args.lookupType}:${args.filter || 'all'}`;
  if (cachedLookups.has(cacheKey)) {
    console.log(`[Cache] Using cached lookup ${cacheKey}`);
    return cachedLookups.get(cacheKey);
  }

  let endpoint = `/lookups/${args.lookupType}/lookupValues`;
  if (args.filter) endpoint += `?filter=${encodeFilter(args.filter)}`;

  const result = await makeRequest(endpoint);
  cachedLookups.set(cacheKey, result);

  return result;
}

async function handleCreateObject(args: {
  objectName: string;
  data: any;
  parentId?: number;
}): Promise<any> {
  const objectPath = pluralize(args.objectName);
  let endpoint = `/${objectPath}`;

  if (args.parentId) {
    endpoint = `/projects/${args.parentId}/${objectPath}`;
  }

  return await makeRequest(endpoint, 'POST', args.data);
}

async function handleUpdateObject(args: {
  objectName: string;
  objectId: number;
  data: any;
  parentId?: number;
}): Promise<any> {
  const objectPath = pluralize(args.objectName);
  let endpoint = `/${objectPath}/${args.objectId}`;

  if (args.parentId) {
    endpoint = `/projects/${args.parentId}/${objectPath}/${args.objectId}`;
  }

  return await makeRequest(endpoint, 'PATCH', args.data);
}

async function handleDeleteObject(args: {
  objectName: string;
  objectId: number;
  parentId?: number;
}): Promise<any> {
  const objectPath = pluralize(args.objectName);
  let endpoint = `/${objectPath}/${args.objectId}`;

  if (args.parentId) {
    endpoint = `/projects/${args.parentId}/${objectPath}/${args.objectId}`;
  }

  await makeRequest(endpoint, 'DELETE');
  return { success: true, deleted: args.objectId };
}

async function handleGetTimesheets(args: {
  fields: string[];
  filter?: string;
  limit?: number;
}): Promise<any> {
  return handleQueryObject({
    objectName: 'timesheets',
    fields: args.fields,
    filter: args.filter,
    limit: args.limit,
  });
}

async function handleGetTimesheetEntries(args: {
  timesheetId: number;
  fields: string[];
}): Promise<any> {
  const fieldsParam = args.fields.join(',');
  const endpoint = `/timesheets/${args.timesheetId}/timeEntries?fields=${fieldsParam}`;
  return await makeRequest(endpoint);
}

async function handleExecuteCustomQuery(args: {
  endpoint: string;
  method: string;
  queryParams?: Record<string, any>;
  body?: any;
}): Promise<any> {
  let endpoint = args.endpoint;

  if (args.queryParams) {
    const params = new URLSearchParams();
    Object.entries(args.queryParams).forEach(([key, value]) => {
      params.append(key, String(value));
    });
    endpoint += `?${params.toString()}`;
  }

  return await makeRequest(endpoint, args.method, args.body);
}

// ============================================================================
// HTTP ROUTES - All 17 Tools
// ============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '2.0.0-smart-agent',
    tools: 17,
    config: {
      baseUrl: config.baseUrl,
      authType: config.authToken ? 'Token' : config.username ? 'Basic Auth' : config.sessionId ? 'Session' : 'None',
      hasAuth: !!(config.authToken || config.username || config.sessionId)
    },
    endpoints: {
      chat: 'POST /api/chat',
      tool: 'POST /api/tool',
      objects: 'GET /api/objects'
    }
  });
});

// Tool 1: Get Objects
app.get('/api/tools/get_objects', async (req, res) => {
  try {
    const result = await handleGetObjects();
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 2: Get Object Attributes
app.get('/api/tools/get_object_attributes', async (req, res) => {
  try {
    const { objectName } = req.query;
    if (!objectName) {
      return res.status(400).json({ error: 'objectName is required' });
    }
    const result = await handleGetObjectAttributes(objectName as string);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 3: Query Object
app.post('/api/tools/query_object', async (req, res) => {
  try {
    const result = await handleQueryObject(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 4: Get Project Tasks
app.post('/api/tools/get_project_tasks', async (req, res) => {
  try {
    const result = await handleGetProjectTasks(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 5: Get Project Teams
app.post('/api/tools/get_project_teams', async (req, res) => {
  try {
    const result = await handleGetProjectTeams(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 6: Get Task Assignments
app.post('/api/tools/get_task_assignments', async (req, res) => {
  try {
    const result = await handleGetTaskAssignments(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 7: Get Lookup Values
app.post('/api/tools/get_lookup_values', async (req, res) => {
  try {
    const result = await handleGetLookupValues(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 8: Create Object
app.post('/api/tools/create_object', async (req, res) => {
  try {
    const result = await handleCreateObject(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 9: Update Object
app.post('/api/tools/update_object', async (req, res) => {
  try {
    const result = await handleUpdateObject(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 10: Delete Object
app.post('/api/tools/delete_object', async (req, res) => {
  try {
    const result = await handleDeleteObject(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 11: Get Timesheets
app.post('/api/tools/get_timesheets', async (req, res) => {
  try {
    const result = await handleGetTimesheets(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 12: Get Timesheet Entries
app.post('/api/tools/get_timesheet_entries', async (req, res) => {
  try {
    const result = await handleGetTimesheetEntries(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 13: Get Cost Plans
app.post('/api/tools/get_cost_plans', async (req, res) => {
  try {
    const result = await handleQueryObject({ 
      objectName: 'costPlans', 
      ...req.body 
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 14: Get Actual Transactions
app.post('/api/tools/get_actual_transactions', async (req, res) => {
  try {
    const result = await handleQueryObject({ 
      objectName: 'actualTransactions', 
      ...req.body 
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 15: Get Roadmaps
app.post('/api/tools/get_roadmaps', async (req, res) => {
  try {
    const result = await handleQueryObject({ 
      objectName: 'roadmaps', 
      ...req.body 
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 16: Get Roadmap Items
app.post('/api/tools/get_roadmap_items', async (req, res) => {
  try {
    const result = await handleGetProjectTasks(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Tool 17: Execute Custom Query
app.post('/api/tools/execute_custom_query', async (req, res) => {
  try {
    const result = await handleExecuteCustomQuery(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// ============================================================================
// UNIFIED TOOL ENDPOINT (for easier client integration)
// ============================================================================

app.post('/api/tool', async (req, res) => {
  try {
    const { tool, args } = req.body;
    
    let result: any;

    switch (tool) {
      case 'get_objects':
        result = await handleGetObjects();
        break;
      case 'get_object_attributes':
        result = await handleGetObjectAttributes(args.objectName);
        break;
      case 'query_object':
        result = await handleQueryObject(args);
        break;
      case 'get_project_tasks':
        result = await handleGetProjectTasks(args);
        break;
      case 'get_project_teams':
        result = await handleGetProjectTeams(args);
        break;
      case 'get_task_assignments':
        result = await handleGetTaskAssignments(args);
        break;
      case 'get_lookup_values':
        result = await handleGetLookupValues(args);
        break;
      case 'create_object':
        result = await handleCreateObject(args);
        break;
      case 'update_object':
        result = await handleUpdateObject(args);
        break;
      case 'delete_object':
        result = await handleDeleteObject(args);
        break;
      case 'get_timesheets':
        result = await handleGetTimesheets(args);
        break;
      case 'get_timesheet_entries':
        result = await handleGetTimesheetEntries(args);
        break;
      case 'get_cost_plans':
        result = await handleQueryObject({ objectName: 'costPlans', ...args });
        break;
      case 'get_actual_transactions':
        result = await handleQueryObject({ objectName: 'actualTransactions', ...args });
        break;
      case 'get_roadmaps':
        result = await handleQueryObject({ objectName: 'roadmaps', ...args });
        break;
      case 'get_roadmap_items':
        result = await handleGetProjectTasks(args);
        break;
      case 'execute_custom_query':
        result = await handleExecuteCustomQuery(args);
        break;
      default:
        return res.status(400).json({ error: `Unknown tool: ${tool}` });
    }

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// ============================================================================
// LEGACY COMPATIBILITY ROUTES (for v20-v34 extension)
// ============================================================================

app.get('/api/objects', async (req, res) => {
  try {
    const result = await handleGetObjects();
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.get('/api/objects/:objectName/attributes', async (req, res) => {
  try {
    const result = await handleGetObjectAttributes(req.params.objectName);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.post('/api/query', async (req, res) => {
  try {
    const result = await handleQueryObject(req.body);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('[Error]', err);
  res.status(500).json({ 
    error: err.message || 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// AI AGENT - Smart Query Processing with Claude API
// ============================================================================

interface QueryIntent {
  action: string;
  objectType?: string;
  projectCode?: string;
  projectId?: number;
  fields?: string[];
  filter?: string;
  limit?: number;
}

async function analyzeIntentWithClaude(message: string, conversationHistory: any[]): Promise<any> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  
  if (!ANTHROPIC_API_KEY) {
    console.log('[AI Agent] No Anthropic API key, falling back to simple parsing');
    return analyzeIntentSimple(message);
  }

  try {
    const systemPrompt = `You are a Clarity PPM assistant. Analyze user queries and determine what Clarity API calls to make.

Available tools:
1. query_projects - Get projects list
2. get_project_by_code - Find project by code (like "this_proj", "TEST01")
3. get_project_tasks - Get tasks for a specific project (needs project ID)
4. get_project_teams - Get team members for a project
5. count_items - Count projects/tasks/resources

When user asks about tasks in a project:
- Step 1: Find the project by code using query_projects with filter
- Step 2: Use the project ID to get tasks

Respond with JSON:
{
  "steps": [
    {"tool": "query_projects", "params": {"filter": "(code = 'PROJECT_CODE')"}, "reason": "Find project ID"},
    {"tool": "get_project_tasks", "params": {"projectId": "FROM_STEP_1"}, "reason": "Get tasks"}
  ],
  "response_format": "List of tasks with completion %"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [
          ...conversationHistory.slice(-3).map((msg: any) => ({
            role: msg.role,
            content: msg.content
          })),
          {
            role: 'user',
            content: `${systemPrompt}\n\nUser query: "${message}"\n\nProvide the execution plan as JSON.`
          }
        ]
      })
    });

    const data = await response.json();
    const content = data.content[0].text;
    
    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    return analyzeIntentSimple(message);
  } catch (error) {
    console.error('[AI Agent] Claude API error:', error);
    return analyzeIntentSimple(message);
  }
}

function analyzeIntentSimple(message: string): QueryIntent {
  const lower = message.toLowerCase();
  
  // Simple fallback parsing
  if (lower.includes('help')) {
    return { action: 'help' };
  }
  
  if (lower.includes('active') && lower.includes('project')) {
    return {
      action: 'list_projects',
      objectType: 'projects',
      filter: '(isActive = true)',
      fields: ['name', 'code', 'manager', 'status', 'percentComplete'],
      limit: 50
    };
  }
  
  if (lower.includes('how many') && lower.includes('project')) {
    return {
      action: 'count_projects',
      objectType: 'projects',
      fields: ['name']
    };
  }
  
  return { action: 'unknown' };
}

function formatResponse(intent: QueryIntent, data: any): string {
  const count = data._totalCount || data._results?.length || 0;
  
  switch (intent.action) {
    case 'count_tasks':
      if (intent.projectCode) {
        return `📊 Project **${intent.projectCode}** has **${count} tasks**.`;
      }
      return `📊 Found **${count} tasks** in total.`;
      
    case 'count_projects':
      return `📊 There are **${count} projects** in the system.`;
      
    case 'count':
      return `📊 Found **${count} ${intent.objectType}** in the system.`;
      
    case 'list_tasks':
      if (count === 0) {
        return `❌ No tasks found${intent.projectCode ? ` in project **${intent.projectCode}**` : ''}.`;
      }
      
      const taskList = data._results?.slice(0, 15).map((t: any, i: number) => {
        const status = t.status?.displayValue || t.status || 'Unknown';
        const progress = t.percentComplete !== undefined ? ` - ${t.percentComplete}%` : '';
        return `${i + 1}. **${t.name}**${progress}`;
      }).join('\n') || '';
      
      const more = count > 15 ? `\n\n_...and ${count - 15} more_` : '';
      const projectInfo = intent.projectCode ? ` in **${intent.projectCode}**` : '';
      return `✅ Found **${count} tasks**${projectInfo}:\n\n${taskList}${more}`;
      
    case 'list_projects':
      if (count === 0) {
        return `❌ No projects found.`;
      }
      
      const projList = data._results?.slice(0, 15).map((p: any, i: number) => {
        const manager = p.manager?.displayValue || '';
        const progress = p.percentComplete !== undefined ? ` - ${p.percentComplete}%` : '';
        const managerText = manager ? ` (Manager: ${manager})` : '';
        return `${i + 1}. **${p.name}** [${p.code}]${progress}${managerText}`;
      }).join('\n') || '';
      
      const moreProj = count > 15 ? `\n\n_...and ${count - 15} more_` : '';
      return `📁 Found **${count} projects**:\n\n${projList}${moreProj}`;
      
    case 'list_teams':
      if (count === 0) {
        return `❌ No team members found.`;
      }
      
      const teamList = data._results?.slice(0, 20).map((t: any, i: number) => {
        const resource = t.resourceId?.displayValue || t.resource?.displayValue || 'Unknown';
        const role = t.role?.displayValue || '';
        const roleText = role ? ` - ${role}` : '';
        return `${i + 1}. ${resource}${roleText}`;
      }).join('\n') || '';
      
      return `👥 Found **${count} team members**:\n\n${teamList}`;
      
    case 'project_details':
      const project = data._results?.[0] || data;
      if (!project || !project.name) {
        return `❌ Project not found.`;
      }
      return `📋 **Project: ${project.name}**\n\n` +
             `**Code:** ${project.code}\n` +
             `**Status:** ${project.status?.displayValue || 'Unknown'}\n` +
             `**Manager:** ${project.manager?.displayValue || 'Not assigned'}\n` +
             `**Progress:** ${project.percentComplete || 0}% complete\n` +
             `**Start:** ${project.scheduleStart || 'N/A'}\n` +
             `**Finish:** ${project.scheduleFinish || 'N/A'}`;
      
    default:
      return `Found ${count} results.`;
  }
}

// ============================================================================
// CHAT ENDPOINT (for browser extension)
// ============================================================================

app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationHistory, clarityBaseUrl, claritySessionId } = req.body;
    
    console.log(`[Chat] Received: "${message}"`);
    console.log(`[Chat] Clarity URL: ${clarityBaseUrl || 'not provided'}`);
    console.log(`[Chat] Session ID: ${claritySessionId ? 'provided' : 'not provided'}`);
    
    // Override config with dynamic values from extension
    if (clarityBaseUrl) {
      config.baseUrl = clarityBaseUrl;
    }
    if (claritySessionId) {
      config.sessionId = claritySessionId;
      config.authToken = undefined;
      config.username = undefined;
      config.password = undefined;
    }
    
    console.log(`[Chat] Using Base URL: ${config.baseUrl}`);
    console.log(`[Chat] Using Auth: ${config.sessionId ? 'Session' : config.authToken ? 'Token' : 'Basic'}`);
    
    // Use Claude API to analyze and execute
    const plan = await analyzeIntentWithClaude(message, conversationHistory || []);
    console.log(`[AI Agent] Execution plan:`, plan);
    
    // Handle simple actions
    if (plan.action === 'help') {
      return res.json({
        success: true,
        reply: `🤖 **I can help you with Clarity PPM!**\n\n` +
               `📊 **Count things:**\n` +
               `- "How many projects?"\n` +
               `- "How many tasks in this_proj?"\n\n` +
               `📋 **List things:**\n` +
               `- "Show me active projects"\n` +
               `- "List tasks in this_proj"\n\n` +
               `Just ask naturally!`,
        timestamp: new Date().toISOString()
      });
    }
    
    if (plan.action === 'unknown') {
      return res.json({
        success: true,
        reply: `🤔 I'm not sure how to help with that. Try "help" for examples.`,
        timestamp: new Date().toISOString()
      });
    }
    
    // Execute multi-step plan
    if (plan.steps && Array.isArray(plan.steps)) {
      let context: any = {};
      let finalResult: any = null;
      
      for (const step of plan.steps) {
        console.log(`[AI Agent] Executing: ${step.tool} - ${step.reason}`);
        
        try {
          // Replace placeholders with values from previous steps
          let params = step.params;
          if (typeof params === 'object') {
            params = JSON.parse(JSON.stringify(params).replace(/"FROM_STEP_(\d+)"/g, (match, stepNum) => {
              return JSON.stringify(context[`step${stepNum}`]);
            }));
          }
          
          // Execute the tool
          let result: any;
          
          if (step.tool === 'query_projects') {
            result = await handleQueryObject({
              objectName: 'projects',
              fields: params.fields || ['id', 'name', 'code'],
              filter: params.filter,
              limit: params.limit || 100
            });
          } else if (step.tool === 'get_project_tasks') {
            const projectId = params.projectId || context.projectId;
            result = await handleGetProjectTasks({
              projectId: projectId,
              fields: params.fields || ['name', 'status', 'percentComplete'],
              limit: params.limit || 100
            });
          } else if (step.tool === 'get_project_teams') {
            const projectId = params.projectId || context.projectId;
            result = await handleGetProjectTeams({
              projectId: projectId,
              fields: params.fields || ['resourceId', 'role']
            });
          }
          
          // Store result in context
          context[`step${plan.steps.indexOf(step) + 1}`] = result;
          
          // Extract useful values
          if (result._results && result._results[0]) {
            if (result._results[0]._internalId) {
              context.projectId = result._results[0]._internalId;
            }
            if (result._results[0].id) {
              context.projectId = context.projectId || result._results[0].id;
            }
          }
          
          finalResult = result;
          
        } catch (error) {
          console.error(`[AI Agent] Step failed:`, error);
          return res.json({
            success: false,
            reply: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // Format final result
      const count = finalResult._totalCount || finalResult._results?.length || 0;
      let reply = `Found ${count} results.`;
      
      if (finalResult._results) {
        const items = finalResult._results.slice(0, 15).map((item: any, i: number) => {
          return `${i + 1}. ${item.name || item.code || 'Unnamed'}`;
        }).join('\n');
        
        const more = count > 15 ? `\n\n_...and ${count - 15} more_` : '';
        reply = `✅ Found **${count} items**:\n\n${items}${more}`;
      }
      
      return res.json({
        success: true,
        reply: reply,
        data: finalResult,
        timestamp: new Date().toISOString()
      });
    }
    
    // Fallback to simple execution
    const intent = plan as QueryIntent;
    
    try {
      let data: any;
      
      if (intent.objectType) {
        data = await handleQueryObject({
          objectName: intent.objectType,
          fields: intent.fields || ['name'],
          filter: intent.filter,
          limit: intent.limit || 200
        });
      } else {
        throw new Error('No valid action determined');
      }
      
      const formattedReply = formatResponse(intent, data);
      
      return res.json({
        success: true,
        reply: formattedReply,
        data: data,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('[Chat] Error:', error);
      return res.json({
        success: false,
        reply: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Chat] Fatal error:', error);
    res.status(500).json({ 
      success: false,
      error: message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

const server = app.listen(PORT, () => {
  console.log('='.repeat(70));
  console.log(`🚀 Clarity PPM HTTP Server v2.0.0`);
  console.log(`📡 Listening on port ${PORT}`);
  console.log(`🔧 Base URL: ${config.baseUrl}`);
  console.log(`🔐 Auth: ${config.authToken ? 'Token' : config.username ? 'Basic' : 'Session'}`);
  console.log(`✅ All 17 tools available`);
  console.log('='.repeat(70));
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Chat endpoint: POST http://localhost:${PORT}/api/chat`);
  console.log(`Unified tool: POST http://localhost:${PORT}/api/tool`);
  console.log('='.repeat(70));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
