#!/usr/bin/env node

/**
 * Clarity PPM MCP Server
 * 
 * A comprehensive Model Context Protocol server for CA Clarity PPM REST API
 * Provides full access to projects, tasks, resources, financials, timesheets, and more
 * 
 * Features:
 * - Complete CRUD operations for all Clarity objects
 * - Smart caching for metadata and attributes
 * - Nested endpoint support (e.g., /projects/{id}/tasks)
 * - Advanced filtering with NSQL syntax
 * - Lookup value resolution
 * - Custom object support
 * 
 * @version 1.0.0
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

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

// Load from environment
const config: ClarityConfig = {
  baseUrl: process.env.CLARITY_BASE_URL || 'http://localhost:8080',
  username: process.env.CLARITY_USERNAME,
  password: process.env.CLARITY_PASSWORD,
  sessionId: process.env.CLARITY_SESSION_ID,
  authToken: process.env.CLARITY_AUTH_TOKEN,
};

// ============================================================================
// CACHING
// ============================================================================

const cachedObjects = new Map<string, any>();
const cachedAttributes = new Map<string, any>();
const cachedLookups = new Map<string, any>();

// ============================================================================
// TOOLS DEFINITION
// ============================================================================

const tools: Tool[] = [
  // Discovery Tools
  {
    name: 'get_objects',
    description: 'Discover all available Clarity objects (projects, tasks, resources, ideas, custom objects, etc.). Use this first to see what objects exist in the system.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_object_attributes',
    description: 'Get complete schema for an object including all field names, types, and constraints. Returns exact field names that must be used in queries.',
    inputSchema: {
      type: 'object',
      properties: {
        objectName: {
          type: 'string',
          description: 'Object name from get_objects (e.g., "projects", "tasks", "resources")',
        },
      },
      required: ['objectName'],
    },
  },

  // Query Tools
  {
    name: 'query_object',
    description: 'Query data from any Clarity object with optional filtering. Supports NSQL filter syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        objectName: {
          type: 'string',
          description: 'Object name (plural form: "projects", "tasks", etc.)',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Field names to return. Use exact names from get_object_attributes.',
        },
        filter: {
          type: 'string',
          description: 'NSQL filter. Examples: (status = \'Active\'), (startDate > \'2024-01-01\')',
        },
        limit: {
          type: 'number',
          description: 'Max records to return (1-200, default 25)',
        },
        offset: {
          type: 'number',
          description: 'Starting record number for pagination',
        },
        sort: {
          type: 'string',
          description: 'Sort order. Examples: "name", "code desc"',
        },
      },
      required: ['objectName', 'fields'],
    },
  },

  // Nested Endpoint Tools
  {
    name: 'get_project_tasks',
    description: 'Get tasks for a specific project using optimized nested endpoint. Faster and more reliable than filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'Project internal ID (get from projects query first)',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task fields to return',
        },
        filter: {
          type: 'string',
          description: 'Optional NSQL filter for tasks',
        },
        limit: {
          type: 'number',
          description: 'Max records (1-200)',
        },
      },
      required: ['projectId', 'fields'],
    },
  },
  {
    name: 'get_project_teams',
    description: 'Get team members for a specific project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number' },
        fields: { type: 'array', items: { type: 'string' } },
        filter: { type: 'string' },
      },
      required: ['projectId', 'fields'],
    },
  },
  {
    name: 'get_task_assignments',
    description: 'Get assignments for a specific task',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number' },
        taskId: { type: 'number' },
        fields: { type: 'array', items: { type: 'string' } },
      },
      required: ['projectId', 'taskId', 'fields'],
    },
  },

  // Lookup Tools
  {
    name: 'get_lookup_values',
    description: 'Get values for a lookup field (dropdown values)',
    inputSchema: {
      type: 'object',
      properties: {
        lookupType: {
          type: 'string',
          description: 'Lookup type code (e.g., "INVESTMENT_OBJ_STATUS", "PRJ_PERCENT_CALC_MODE")',
        },
        filter: {
          type: 'string',
          description: 'Filter by code or id. Example: (code = \'ACTIVE\')',
        },
      },
      required: ['lookupType'],
    },
  },

  // Create/Update/Delete Tools
  {
    name: 'create_object',
    description: 'Create a new object instance (project, task, resource, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        objectName: { type: 'string' },
        data: {
          type: 'object',
          description: 'Object data with field values',
        },
        parentId: {
          type: 'number',
          description: 'Parent ID for nested objects (e.g., projectId for tasks)',
        },
      },
      required: ['objectName', 'data'],
    },
  },
  {
    name: 'update_object',
    description: 'Update an existing object (partial update - PATCH)',
    inputSchema: {
      type: 'object',
      properties: {
        objectName: { type: 'string' },
        objectId: { type: 'number' },
        data: { type: 'object' },
        parentId: { type: 'number' },
      },
      required: ['objectName', 'objectId', 'data'],
    },
  },
  {
    name: 'delete_object',
    description: 'Delete an object instance',
    inputSchema: {
      type: 'object',
      properties: {
        objectName: { type: 'string' },
        objectId: { type: 'number' },
        parentId: { type: 'number' },
      },
      required: ['objectName', 'objectId'],
    },
  },

  // Timesheet Tools
  {
    name: 'get_timesheets',
    description: 'Query timesheets with filtering',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: { type: 'string' } },
        filter: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['fields'],
    },
  },
  {
    name: 'get_timesheet_entries',
    description: 'Get time entries for a specific timesheet',
    inputSchema: {
      type: 'object',
      properties: {
        timesheetId: { type: 'number' },
        fields: { type: 'array', items: { type: 'string' } },
      },
      required: ['timesheetId', 'fields'],
    },
  },

  // Financial Tools
  {
    name: 'get_cost_plans',
    description: 'Query cost/budget plans',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: { type: 'string' } },
        filter: { type: 'string' },
      },
      required: ['fields'],
    },
  },
  {
    name: 'get_actual_transactions',
    description: 'Query actual financial transactions',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: { type: 'string' } },
        filter: { type: 'string' },
      },
      required: ['fields'],
    },
  },

  // Roadmap Tools
  {
    name: 'get_roadmaps',
    description: 'Query roadmaps',
    inputSchema: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: { type: 'string' } },
        filter: { type: 'string' },
      },
      required: ['fields'],
    },
  },
  {
    name: 'get_roadmap_items',
    description: 'Get items for a specific roadmap',
    inputSchema: {
      type: 'object',
      properties: {
        roadmapId: { type: 'number' },
        fields: { type: 'array', items: { type: 'string' } },
      },
      required: ['roadmapId', 'fields'],
    },
  },

  // Advanced Query Tool
  {
    name: 'execute_custom_query',
    description: 'Execute a custom API request with full control over endpoint, method, headers, and body',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          description: 'API endpoint path (e.g., "/projects" or "/projects/5004001/tasks")',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
          description: 'HTTP method',
        },
        queryParams: {
          type: 'object',
          description: 'Query parameters as key-value pairs',
        },
        body: {
          type: 'object',
          description: 'Request body for POST/PATCH/PUT',
        },
      },
      required: ['endpoint', 'method'],
    },
  },
];

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

  // Build headers
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...headers,
  };

  // Add authentication
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

  console.error(`[Request] ${method} ${url}`);

  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`API Error ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

// ============================================================================
// URL ENCODING HELPER
// ============================================================================

function encodeFilter(filter: string): string {
  if (!filter) return '';
  
  // Custom encoding for Clarity NSQL:
  // - Replace spaces with +
  // - Replace = with %3D
  // - Replace single quotes with %27
  // - Convert double quotes to single quotes
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

// ============================================================================
// PLURALIZATION
// ============================================================================

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
};

function pluralize(objectName: string): string {
  const lower = objectName.toLowerCase();
  return pluralMap[lower] || objectName;
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

async function handleGetObjects(): Promise<string> {
  // Check cache
  if (cachedObjects.size > 0) {
    console.error('[Cache] Using cached objects list');
    return JSON.stringify(Array.from(cachedObjects.values()));
  }

  const endpoint = `/describe?filter=((extensions+in+('inv')))`;
  const result = await makeRequest(endpoint);

  // Cache results
  if (result._results) {
    result._results.forEach((obj: any) => {
      cachedObjects.set(obj.resourceName, obj);
    });
  }

  return JSON.stringify(result);
}

async function handleGetObjectAttributes(objectName: string): Promise<string> {
  // Check cache
  if (cachedAttributes.has(objectName)) {
    console.error(`[Cache] Using cached attributes for ${objectName}`);
    return JSON.stringify(cachedAttributes.get(objectName));
  }

  const endpoint = `/describeAttributes?filter=(resourceName+%3D+%27${objectName}%27)`;
  const result = await makeRequest(endpoint);

  // Cache result
  cachedAttributes.set(objectName, result);
  console.error(`[Cache] Stored attributes for ${objectName}`);

  return JSON.stringify(result);
}

async function handleQueryObject(args: {
  objectName: string;
  fields: string[];
  filter?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}): Promise<string> {
  const objectPath = pluralize(args.objectName);
  const fieldsParam = args.fields.join(',');

  let endpoint = `/ppm/rest/v1/${objectPath}?fields=${fieldsParam}`;

  if (args.filter) {
    endpoint += `&filter=${encodeFilter(args.filter)}`;
  }
  if (args.limit) {
    endpoint += `&limit=${args.limit}`;
  }
  if (args.offset) {
    endpoint += `&offset=${args.offset}`;
  }
  if (args.sort) {
    endpoint += `&sort=${args.sort}`;
  }

  const result = await makeRequest(endpoint);
  return JSON.stringify(result);
}

async function handleGetProjectTasks(args: {
  projectId: number;
  fields: string[];
  filter?: string;
  limit?: number;
}): Promise<string> {
  const fieldsParam = args.fields.join(',');
  let endpoint = `/projects/${args.projectId}/tasks?fields=${fieldsParam}`;

  if (args.filter) {
    endpoint += `&filter=${encodeFilter(args.filter)}`;
  }
  if (args.limit) {
    endpoint += `&limit=${args.limit}`;
  }

  const result = await makeRequest(endpoint);
  return JSON.stringify(result);
}

async function handleGetProjectTeams(args: {
  projectId: number;
  fields: string[];
  filter?: string;
}): Promise<string> {
  const fieldsParam = args.fields.join(',');
  let endpoint = `/projects/${args.projectId}/teams?fields=${fieldsParam}`;

  if (args.filter) {
    endpoint += `&filter=${encodeFilter(args.filter)}`;
  }

  const result = await makeRequest(endpoint);
  return JSON.stringify(result);
}

async function handleGetTaskAssignments(args: {
  projectId: number;
  taskId: number;
  fields: string[];
}): Promise<string> {
  const fieldsParam = args.fields.join(',');
  const endpoint = `/projects/${args.projectId}/tasks/${args.taskId}/assignments?fields=${fieldsParam}`;

  const result = await makeRequest(endpoint);
  return JSON.stringify(result);
}

async function handleGetLookupValues(args: {
  lookupType: string;
  filter?: string;
}): Promise<string> {
  // Check cache
  const cacheKey = `${args.lookupType}:${args.filter || 'all'}`;
  if (cachedLookups.has(cacheKey)) {
    console.error(`[Cache] Using cached lookup ${cacheKey}`);
    return JSON.stringify(cachedLookups.get(cacheKey));
  }

  let endpoint = `/lookups/${args.lookupType}/lookupValues`;
  
  if (args.filter) {
    endpoint += `?filter=${encodeFilter(args.filter)}`;
  }

  const result = await makeRequest(endpoint);

  // Cache result
  cachedLookups.set(cacheKey, result);

  return JSON.stringify(result);
}

async function handleCreateObject(args: {
  objectName: string;
  data: any;
  parentId?: number;
}): Promise<string> {
  const objectPath = pluralize(args.objectName);
  let endpoint = `/${objectPath}`;

  if (args.parentId) {
    // Nested creation - need parent type
    // This is a simplified version; real implementation would need parent type mapping
    endpoint = `/projects/${args.parentId}/${objectPath}`;
  }

  const result = await makeRequest(endpoint, 'POST', args.data);
  return JSON.stringify(result);
}

async function handleUpdateObject(args: {
  objectName: string;
  objectId: number;
  data: any;
  parentId?: number;
}): Promise<string> {
  const objectPath = pluralize(args.objectName);
  let endpoint = `/${objectPath}/${args.objectId}`;

  if (args.parentId) {
    endpoint = `/projects/${args.parentId}/${objectPath}/${args.objectId}`;
  }

  const result = await makeRequest(endpoint, 'PATCH', args.data);
  return JSON.stringify(result);
}

async function handleDeleteObject(args: {
  objectName: string;
  objectId: number;
  parentId?: number;
}): Promise<string> {
  const objectPath = pluralize(args.objectName);
  let endpoint = `/${objectPath}/${args.objectId}`;

  if (args.parentId) {
    endpoint = `/projects/${args.parentId}/${objectPath}/${args.objectId}`;
  }

  await makeRequest(endpoint, 'DELETE');
  return JSON.stringify({ success: true, deleted: args.objectId });
}

async function handleGetTimesheets(args: {
  fields: string[];
  filter?: string;
  limit?: number;
}): Promise<string> {
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
}): Promise<string> {
  const fieldsParam = args.fields.join(',');
  const endpoint = `/timesheets/${args.timesheetId}/timeEntries?fields=${fieldsParam}`;
  const result = await makeRequest(endpoint);
  return JSON.stringify(result);
}

async function handleExecuteCustomQuery(args: {
  endpoint: string;
  method: string;
  queryParams?: Record<string, any>;
  body?: any;
}): Promise<string> {
  let endpoint = args.endpoint;

  if (args.queryParams) {
    const params = new URLSearchParams();
    Object.entries(args.queryParams).forEach(([key, value]) => {
      params.append(key, String(value));
    });
    endpoint += `?${params.toString()}`;
  }

  const result = await makeRequest(endpoint, args.method, args.body);
  return JSON.stringify(result);
}

// ============================================================================
// MCP SERVER
// ============================================================================

const server = new Server(
  {
    name: 'clarity-ppm-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case 'get_objects':
        result = await handleGetObjects();
        break;

      case 'get_object_attributes':
        result = await handleGetObjectAttributes(args.objectName as string);
        break;

      case 'query_object':
        result = await handleQueryObject(args as any);
        break;

      case 'get_project_tasks':
        result = await handleGetProjectTasks(args as any);
        break;

      case 'get_project_teams':
        result = await handleGetProjectTeams(args as any);
        break;

      case 'get_task_assignments':
        result = await handleGetTaskAssignments(args as any);
        break;

      case 'get_lookup_values':
        result = await handleGetLookupValues(args as any);
        break;

      case 'create_object':
        result = await handleCreateObject(args as any);
        break;

      case 'update_object':
        result = await handleUpdateObject(args as any);
        break;

      case 'delete_object':
        result = await handleDeleteObject(args as any);
        break;

      case 'get_timesheets':
        result = await handleGetTimesheets(args as any);
        break;

      case 'get_timesheet_entries':
        result = await handleGetTimesheetEntries(args as any);
        break;

      case 'get_cost_plans':
        result = await handleQueryObject({ objectName: 'costPlans', ...args as any });
        break;

      case 'get_actual_transactions':
        result = await handleQueryObject({ objectName: 'actualTransactions', ...args as any });
        break;

      case 'get_roadmaps':
        result = await handleQueryObject({ objectName: 'roadmaps', ...args as any });
        break;

      case 'get_roadmap_items':
        result = await handleGetProjectTasks(args as any); // Similar pattern
        break;

      case 'execute_custom_query':
        result = await handleExecuteCustomQuery(args as any);
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: result,
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: errorMessage }),
        },
      ],
      isError: true,
    };
  }
});

// ============================================================================
// START SERVER
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Clarity PPM MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
