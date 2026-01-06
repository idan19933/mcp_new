#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js';
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// AI Configuration
// ============================================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';
const MAX_ITERATIONS = 20;

// ============================================================================
// Database Config
// ============================================================================
const DB_CONFIG = {
  user: process.env.DB_USER || 'niku',
  password: process.env.DB_PASSWORD || 'niku',
  server: process.env.DB_SERVER || '16.16.83.171',
  database: process.env.DB_NAME || 'niku',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: {
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000
  }
};

let pool: sql.ConnectionPool | null = null;

async function getPool() {
  if (pool?.connected) return pool;
  try {
    pool = await new sql.ConnectionPool(DB_CONFIG).connect();
    console.error('✅ Database Connected (Pool Ready)');
    pool.on('error', (err: any) => console.error('Pool Error:', err));
    return pool;
  } catch (err) {
    console.error('❌ DB Connection Failed:', err);
    throw err;
  }
}

// ============================================================================
// SESSION & PERMISSIONS
// ============================================================================
interface UserSession {
  userId: string;
  userName: string;
  cookies: string;
  permissions: Map<string, ObjectPermissions>;
  isAdmin: boolean;
}

interface ObjectPermissions {
  objectCode: string;
  objectName: string;
  canRead: boolean;
  canWrite: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canExecute: boolean;
}

// ============================================================================
// ENHANCED OBJECT DISCOVERY
// ============================================================================
interface ClarityObject {
  objectCode: string;
  objectName: string;
  tableName: string;
  pkColumn: string;
  objectType: string;
  description: string;
}

let clarityObjects: Map<string, ClarityObject> = new Map();
let objectsLoaded = false;

async function loadClarityObjects() {
  if (objectsLoaded) return;
  
  try {
    const db = await getPool();
    
    // [FIX 3] RELIABLE COLUMN SELECTION
    // 1. Get CODE and NAME from ODF_OBJECTS (Reliable)
    // 2. Get OBJECT_TYPE_CODE from CMN_SEC_OBJECTS (As seen in your screenshot)
    const query = `
      SELECT 
        UPPER(o.code) as OBJECT_CODE,
        o.NAME as OBJECT_NAME,         -- [FIX] Use ODF_OBJECTS.NAME
        o.database_table as TABLE_NAME,
        s.OBJECT_TYPE_CODE as OBJECT_TYPE,
        'ID' as PK_COLUMN
      FROM ODF_OBJECTS o
      INNER JOIN CMN_SEC_OBJECTS s ON s.OBJECT_CODE = o.CODE
      WHERE o.is_active = 1
      AND o.database_table IS NOT NULL
      ORDER BY o.code
    `;

    const result = await db.request().query(query);
    console.log(`[Objects] Loaded ${result.recordset.length} Clarity objects`);

    result.recordset.forEach((obj: any) => {
      let pk = 'ID';
      const tableName = obj.TABLE_NAME?.toUpperCase() || '';
      
      if (['PRTASK', 'PRASSIGNMENT', 'PRTEAM', 'PRRESOURCEMAP', 'PRJ_OBS_ASSOCIATIONS'].includes(tableName)) {
        pk = 'PRID';
      }

      clarityObjects.set(obj.OBJECT_CODE, {
        objectCode: obj.OBJECT_CODE,
        objectName: obj.OBJECT_NAME || obj.OBJECT_CODE,
        tableName: obj.TABLE_NAME,
        pkColumn: pk,
        objectType: obj.OBJECT_TYPE || 'OBJECT',
        description: ''
      });
    });

    objectsLoaded = true;
    console.log(`[Objects] Mapped ${clarityObjects.size} objects`);
  } catch (error: any) {
    console.error('[Objects] Error loading:', error.message);
  }
}

// ============================================================================
// SCHEMA DISCOVERY
// ============================================================================
async function getObjectSchema(objectCode: string): Promise<string> {
  try {
    const obj = clarityObjects.get(objectCode.toUpperCase());
    if (!obj || !obj.tableName) {
      return `Object ${objectCode} not found. Use list_objects to see available objects.`;
    }

    const db = await getPool();
    const schema = await db.request()
      .input('tableName', obj.tableName)
      .query(`
        SELECT 
          COLUMN_NAME,
          DATA_TYPE,
          CHARACTER_MAXIMUM_LENGTH,
          IS_NULLABLE,
          COLUMN_DEFAULT
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = @tableName
        ORDER BY ORDINAL_POSITION
      `);

    if (schema.recordset.length === 0) {
      return `No schema found for table ${obj.tableName}`;
    }

    const schemaInfo = {
      objectCode: obj.objectCode,
      objectName: obj.objectName,
      tableName: obj.tableName,
      primaryKey: obj.pkColumn,
      columns: schema.recordset.map((col: any) => ({
        name: col.COLUMN_NAME,
        type: col.DATA_TYPE,
        maxLength: col.CHARACTER_MAXIMUM_LENGTH,
        nullable: col.IS_NULLABLE === 'YES',
        default: col.COLUMN_DEFAULT
      }))
    };

    return JSON.stringify(schemaInfo, null, 2);

  } catch (error: any) {
    return `Error getting schema: ${error.message}`;
  }
}

// ============================================================================
// USER AUTHENTICATION
// ============================================================================
async function getUserFromSession(session: any): Promise<string | null> {
  try {
    const db = await getPool();

    // 1. Session Cookie (Chrome Extension)
    if (session?.cookies) {
      const sessionMatch = session.cookies.match(/JSESSIONID=([^;]+)/);
      if (sessionMatch) {
        let sessionId = sessionMatch[1];
        if (sessionId.includes('.')) sessionId = sessionId.split('.')[0];

        const result = await db.request().input('sessionId', sessionId).query(`
            SELECT TOP 1 u.ID as USER_ID, u.USER_NAME
            FROM CMN_SEC_USERS u
            INNER JOIN CMN_SEC_USER_SESSIONS s ON s.USER_ID = u.ID
            WHERE s.SESSION_ID = @sessionId
            AND s.LAST_UPDATED_DATE > DATEADD(hour, -24, GETDATE())
          `);

        if (result.recordset.length > 0) {
          console.log('[Auth] ✅ Cookie Auth:', result.recordset[0].USER_NAME);
          return result.recordset[0].USER_ID.toString();
        }
      }
    }

    // 2. Username
    if (session?.username) {
      const result = await db.request().input('username', session.username).query(`
          SELECT TOP 1 ID as USER_ID, USER_NAME
          FROM CMN_SEC_USERS WHERE USER_NAME = @username AND USER_STATUS_ID = 1
        `);

      if (result.recordset.length > 0) {
        console.log('[Auth] ✅ Username Auth:', result.recordset[0].USER_NAME);
        return result.recordset[0].USER_ID.toString();
      }

      // 3. Admin Fallback (Group Code)
      console.warn('[Auth] ⚠️ User not found. Trying Admin Fallback...');
      const adminResult = await db.request().query(`
          SELECT TOP 1 u.ID as USER_ID, u.USER_NAME
          FROM CMN_SEC_USERS u
          INNER JOIN CMN_SEC_USER_GROUPS ug ON ug.USER_ID = u.ID
          INNER JOIN CMN_SEC_GROUPS g ON g.ID = ug.GROUP_ID
          WHERE g.GROUP_CODE IN ('Admin', 'ProcessAdmin', 'SystemAdmin')
          AND u.USER_STATUS_ID = 1
        `);
      
      if (adminResult.recordset.length > 0) {
        console.log('[Auth] ⚠️ Using Admin Fallback:', adminResult.recordset[0].USER_NAME);
        return adminResult.recordset[0].USER_ID.toString();
      }

      // 4. EMERGENCY FALLBACK (Any Active User)
      // This ensures we always have SOMEONE to log in as for testing
      console.warn('[Auth] 🚨 Admin check failed. Using ANY active user...');
      const anyUser = await db.request().query(`
          SELECT TOP 1 ID as USER_ID, USER_NAME 
          FROM CMN_SEC_USERS 
          WHERE USER_STATUS_ID = 1 
          ORDER BY ID ASC
      `);
      
      if (anyUser.recordset.length > 0) {
         console.log('[Auth] 🚨 Using Emergency User:', anyUser.recordset[0].USER_NAME);
         return anyUser.recordset[0].USER_ID.toString();
      }
    }

    console.error('[Auth] ❌ Authentication Failed completely.');
    return null;

  } catch (error: any) {
    console.error('[Auth] Error:', error.message);
    return null;
  }
}

// Get user permissions
async function getUserPermissions(userId: string): Promise<UserSession['permissions']> {
  try {
    const db = await getPool();

    const adminCheck = await db.request()
      .input('userId', userId)
      .query(`
        SELECT COUNT(*) as is_admin
        FROM CMN_SEC_USER_GROUPS ug
        INNER JOIN CMN_SEC_GROUPS g ON g.ID = ug.GROUP_ID
        WHERE ug.USER_ID = @userId
        AND g.GROUP_CODE IN ('Admin', 'ProcessAdmin', 'SystemAdmin')
      `);

    const isAdmin = adminCheck.recordset[0].is_admin > 0;
    const permissions = new Map<string, ObjectPermissions>();

    if (isAdmin) {
      clarityObjects.forEach((obj) => {
        permissions.set(obj.objectCode, {
          objectCode: obj.objectCode,
          objectName: obj.objectName,
          canRead: true, canWrite: true, canUpdate: true, canDelete: true, canExecute: true
        });
      });
      return permissions;
    }

    const permsResult = await db.request()
      .input('userId', userId)
      .query(`
        SELECT DISTINCT
          ar.OBJECT_CODE,
          MAX(CAST(ar.CAN_READ as INT)) as CAN_READ,
          MAX(CAST(ar.CAN_WRITE as INT)) as CAN_WRITE,
          MAX(CAST(ar.CAN_UPDATE as INT)) as CAN_UPDATE,
          MAX(CAST(ar.CAN_DELETE as INT)) as CAN_DELETE
        FROM CMN_SEC_ACCESS_RIGHTS ar
        WHERE ar.PRINCIPAL_ID IN (
          SELECT GROUP_ID FROM CMN_SEC_USER_GROUPS WHERE USER_ID = @userId
          UNION SELECT @userId
        )
        AND ar.IS_ACTIVE = 1
        GROUP BY ar.OBJECT_CODE
      `);

    permsResult.recordset.forEach((perm: any) => {
      const knownObj = clarityObjects.get(perm.OBJECT_CODE);
      if (knownObj) {
        permissions.set(perm.OBJECT_CODE, {
          objectCode: perm.OBJECT_CODE,
          objectName: knownObj.objectName,
          canRead: perm.CAN_READ === 1,
          canWrite: perm.CAN_WRITE === 1,
          canUpdate: perm.CAN_UPDATE === 1,
          canDelete: perm.CAN_DELETE === 1,
          canExecute: false
        });
      }
    });

    return permissions;

  } catch (error: any) {
    console.error('[Permissions] Error:', error.message);
    return new Map();
  }
}

// ============================================================================
// CURRENT PAGE CONTEXT
// ============================================================================
interface PageContext {
  pageType: string;
  objectCode: string;
  objectId: string | null;
  objectName: string | null;
  url: string;
}

async function getPageObjectDetails(context: PageContext, session: UserSession): Promise<string> {
  if (!context.objectId) return 'No object ID found';

  const obj = clarityObjects.get(context.objectCode);
  if (!obj || !obj.tableName) return `Object ${context.objectCode} not found`;

  try {
    const db = await getPool();
    const query = `SELECT TOP 1 * FROM ${obj.tableName} WITH(NOLOCK) WHERE ${obj.pkColumn} = @id`;
    console.log(`[SQL] ${query}`);
    
    const result = await db.request().input('id', context.objectId).query(query);
    if (result.recordset.length === 0) return 'No data found';

    return JSON.stringify(result.recordset[0], null, 2);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// ============================================================================
// GENERIC CRUD
// ============================================================================
async function executeGenericCRUD(
  action: string,
  objectCode: string,
  args: any,
  session: UserSession | null
): Promise<string> {
  
  const obj = clarityObjects.get(objectCode.toUpperCase());
  if (!obj || !obj.tableName) {
    return `❌ Object ${objectCode} not found.`;
  }

  // Permission Check
  if (session && !session.isAdmin) {
    const perm = session.permissions.get(obj.objectCode);
    if (!perm) return `❌ No permissions for ${obj.objectName}`;
    if (action === 'read' && !perm.canRead) return `❌ No READ permission`;
    if (action === 'create' && !perm.canWrite) return `❌ No WRITE permission`;
    if (action === 'update' && !perm.canUpdate) return `❌ No UPDATE permission`;
    if (action === 'delete' && !perm.canDelete) return `❌ No DELETE permission`;
  }

  const db = await getPool();

  try {
    switch (action) {
      case 'read': {
        const limit = args.limit || 50;
        const req = db.request();
        let whereClause = '';
        if (args.where) {
          const whereParts: string[] = [];
          Object.entries(args.where).forEach(([key, val], idx) => {
            whereParts.push(`${key} = @w${idx}`);
            req.input(`w${idx}`, val);
          });
          whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
        }
        
        const query = `SELECT TOP ${limit} * FROM ${obj.tableName} WITH(NOLOCK) ${whereClause}`;
        const result = await req.query(query);
        return JSON.stringify(result.recordset, null, 2);
      }

      case 'create': {
        const req = db.request();
        const cols: string[] = [];
        const vals: string[] = [];
        Object.entries(args.data).forEach(([key, val], idx) => {
          cols.push(key);
          vals.push(`@v${idx}`);
          req.input(`v${idx}`, val);
        });
        await req.query(`INSERT INTO ${obj.tableName} (${cols.join(',')}) VALUES (${vals.join(',')})`);
        return `✅ Created ${obj.objectName}`;
      }

      case 'update': {
        const req = db.request();
        const updates: string[] = [];
        Object.entries(args.data).forEach(([key, val], idx) => {
          updates.push(`${key} = @u${idx}`);
          req.input(`u${idx}`, val);
        });
        req.input('id', args.id);
        const result = await req.query(`UPDATE ${obj.tableName} SET ${updates.join(', ')} WHERE ${obj.pkColumn} = @id`);
        return `✅ Updated ${result.rowsAffected[0]} records`;
      }

      case 'delete': {
        const req = db.request();
        req.input('id', args.id);
        const result = await req.query(`DELETE FROM ${obj.tableName} WHERE ${obj.pkColumn} = @id`);
        return `✅ Deleted ${result.rowsAffected[0]} records`;
      }
    }
    return 'Unknown action';
  } catch (error: any) {
    return `❌ Database Error: ${error.message}. use get_schema to check columns.`;
  }
}

// ============================================================================
// DYNAMIC SQL ENGINE
// ============================================================================
async function executeDynamicQuery(sqlQuery: string, session: UserSession | null): Promise<string> {
  const forbidden = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC'];
  const upperSQL = sqlQuery.toUpperCase().trim();
  
  if (!upperSQL.startsWith('SELECT') && !upperSQL.startsWith('WITH')) {
    return '❌ Security: Only SELECT queries allowed.';
  }
  if (forbidden.some(w => upperSQL.includes(` ${w} `) || upperSQL.includes(`\n${w} `))) {
    return '❌ Security: No destructive commands allowed.';
  }

  try {
    const db = await getPool();
    console.log(`[Dynamic SQL] ${sqlQuery}`);
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length > 100) {
      return JSON.stringify(result.recordset.slice(0, 100), null, 2) + `\n...(${result.recordset.length} total)`;
    }
    return JSON.stringify(result.recordset, null, 2);
  } catch (error: any) {
    return `❌ SQL Error: ${error.message}`;
  }
}

// ============================================================================
// AI AGENT
// ============================================================================
async function runAIAgentLoop(
  userMessage: string,
  context: PageContext,
  session: UserSession | null,
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) return 'AI not configured';
  await loadClarityObjects();

  const systemPrompt = `You are a Clarity PPM SQL Expert.
  
  CAPABILITIES:
  1. **Analysis**: Use 'run_read_only_sql' for complex questions (Counts, Sums, Joins).
  2. **Modifications**: Use 'generic_crud' for safe updates.
  3. **Discovery**: ALWAYS use 'get_schema' before writing SQL to check column names.

  RULES:
  - Check schema before assuming column names (e.g. is it 'NAME' or 'FULL_NAME'?).
  - Use 'list_objects' to find table names.
  - Use table aliases in SQL.
  - Use WITH(NOLOCK) for performance.

  Context: ${JSON.stringify(context)}
  User: ${session?.userName || 'Guest'} (${session?.isAdmin ? 'ADMIN' : 'User'})
  `;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_read_only_sql',
        description: 'Run SELECT query. Check schema first!',
        parameters: { type: 'object', properties: { sqlQuery: { type: 'string' } }, required: ['sqlQuery'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_schema',
        description: 'Get columns for an object. REQUIRED before SQL.',
        parameters: { type: 'object', properties: { objectCode: { type: 'string' } }, required: ['objectCode'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_objects',
        description: 'List available objects.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'generic_crud',
        description: 'Create/Update/Delete records.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['read','create','update','delete'] },
            objectCode: { type: 'string' },
            data: { type: 'object' },
            id: { type: 'string' },
            where: { type: 'object' }
          },
          required: ['action', 'objectCode']
        }
      }
    }
  ];

  let messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  let iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    sendUpdate({ type: 'thinking', data: `Reasoning... (${iteration})` });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages, tools, tool_choice: 'auto' })
    });

    const data: any = await response.json();
    const message = data.choices[0].message;

    if (message.tool_calls) {
      messages.push(message);
      for (const call of message.tool_calls) {
        const fn = call.function.name;
        const args = JSON.parse(call.function.arguments);
        sendUpdate({ type: 'tool', data: `🔧 ${fn}` });
        
        let res = '';
        try {
          if (fn === 'run_read_only_sql') res = await executeDynamicQuery(args.sqlQuery, session);
          else if (fn === 'get_schema') res = await getObjectSchema(args.objectCode);
          else if (fn === 'list_objects') {
            const list: string[] = [];
            clarityObjects.forEach(o => list.push(`${o.objectCode} (${o.tableName})`));
            res = list.join('\n');
          }
          else if (fn === 'generic_crud') res = await executeGenericCRUD(args.action, args.objectCode, args, session);
          else res = 'Unknown tool';
        } catch (e: any) { res = `Error: ${e.message}`; }

        messages.push({ role: 'tool', tool_call_id: call.id, content: res });
      }
    } else {
      sendUpdate({ type: 'complete', data: message.content });
      return message.content;
    }
  }
  return 'Timeout';
}

// ============================================================================
// SERVER
// ============================================================================
async function startHTTPServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3001');
  app.use(express.json());
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
  });

  await getPool();
  await loadClarityObjects();

  app.post('/api/chat', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const send = (d: any) => res.write(`data: ${JSON.stringify(d)}\n\n`);

    const { message, context, session } = req.body;
    
    let userSession: UserSession | null = null;
    if (session) {
      const uid = await getUserFromSession(session);
      if (uid) {
        const perms = await getUserPermissions(uid);
        const isAdmin = Array.from(perms.values()).every(p => p.canRead && p.canWrite);
        userSession = { userId: uid, userName: session.username || 'User', cookies: '', permissions: perms, isAdmin };
        send({ type: 'info', data: `🔐 Logged in as ${userSession.userName}` });
      } else {
        send({ type: 'warning', data: '⚠️ Not Authenticated' });
      }
    }

    try { await runAIAgentLoop(message, context, userSession, send); }
    catch (e: any) { send({ type: 'error', data: e.message }); }
    res.end();
  });

  app.listen(PORT, () => {
    console.log(`🚀 Clarity MCP Running on ${PORT}`);
    console.log(`✅ Objects Loaded: ${clarityObjects.size}`);
  });
}

startHTTPServer().catch(console.error);
