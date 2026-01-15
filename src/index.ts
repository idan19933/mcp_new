/**
 * Clarity PPM HTTP Server
 * Version 2.0.0 - Complete Edition
 * 
 * Full-featured HTTP wrapper with all 17 tools from MCP server
 * For Railway deployment with browser extension support
 */

import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(cors());
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
    requestHeaders['Cookie'] = `JSESSIONID=${config.sessionId}`;
  }

  const options: RequestInit = {
    method,
    headers: requestHeaders,
  };

  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  console.log(`[Clarity API] ${method} ${url}`);

  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`API Error ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
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
    version: '2.0.0',
    tools: 17,
    config: {
      baseUrl: config.baseUrl,
      hasAuth: !!(config.authToken || config.username || config.sessionId)
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

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Error]', err);
  res.status(500).json({ 
    error: err.message || 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// CHAT ENDPOINT (for browser extension)
// ============================================================================

app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;
    
    // Simple echo for testing - replace with actual AI logic later
    const response = {
      success: true,
      reply: `Received: ${message}`,
      timestamp: new Date().toISOString(),
      tools_available: 17
    };
    
    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

const HOST = '0.0.0.0'; // Important: bind to all interfaces for Railway

app.listen(PORT, HOST, () => {
  console.log('='.repeat(70));
  console.log(`🚀 Clarity PPM HTTP Server v2.0.0`);
  console.log(`📡 Listening on ${HOST}:${PORT}`);
  console.log(`🔧 Base URL: ${config.baseUrl}`);
  console.log(`🔐 Auth: ${config.authToken ? 'Token' : config.username ? 'Basic' : 'Session'}`);
  console.log(`✅ All 17 tools available`);
  console.log('='.repeat(70));
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Chat endpoint: POST http://localhost:${PORT}/api/chat`);
  console.log(`Unified tool: POST http://localhost:${PORT}/api/tool`);
  console.log('='.repeat(70));
});
