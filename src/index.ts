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
const MAX_ITERATIONS = 20; // More iterations for schema discovery

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
// ENHANCED OBJECT DISCOVERY with ODF Support
// ============================================================================
interface ClarityObject {
  objectCode: string;
  objectName: string;
  tableName: string;
  pkColumn: string; // 'ID' or 'PRID'
  objectType: string;
  description: string;
}

let clarityObjects: Map<string, ClarityObject> = new Map();
let objectsLoaded = false;

async function loadClarityObjects() {
  if (objectsLoaded) return;
  
  try {
    const db = await getPool();
    
    // FIXED: Correct column names from actual Clarity schema
    const query = `
      SELECT 
        UPPER(o.code) as OBJECT_CODE,
        s.OBJECT_NAME as OBJECT_NAME, 
        o.database_table as TABLE_NAME,
        s.OBJECT_TYPE_CODE as OBJECT_TYPE,
        'ID' as PK_COLUMN
      FROM ODF_OBJECTS o
      INNER JOIN CMN_SEC_OBJECTS s ON s.OBJECT_CODE = o.CODE
      WHERE o.is_active = 1
      AND o.database_table IS NOT NULL
      ORDER BY s.OBJECT_NAME
    `;

    const result = await db.request().query(query);
    console.log(`[Objects] Loaded ${result.recordset.length} Clarity objects`);

    result.recordset.forEach((obj: any) => {
      // Handle special Clarity cases where PK is PRID
      let pk = obj.PK_COLUMN || 'ID';
      const tableName = obj.TABLE_NAME?.toUpperCase() || '';
      
      if (['PRTASK', 'PRASSIGNMENT', 'PRTEAM', 'PRRESOURCEMAP'].includes(tableName)) {
        pk = 'PRID';
      }

      clarityObjects.set(obj.OBJECT_CODE, {
        objectCode: obj.OBJECT_CODE,
        objectName: obj.OBJECT_NAME || obj.OBJECT_CODE,
        tableName: obj.TABLE_NAME,
        pkColumn: pk,
        objectType: obj.OBJECT_TYPE || 'OBJECT',
        description: obj.DESCRIPTION || ''
      });
    });

    objectsLoaded = true;
    console.log(`[Objects] Mapped ${clarityObjects.size} objects`);
  } catch (error: any) {
    console.error('[Objects] Error loading:', error.message);
  }
}

// ============================================================================
// SCHEMA DISCOVERY - The MVP Feature!
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
// USER AUTHENTICATION with Fallback
// ============================================================================
async function getUserFromSession(session: any): Promise<string | null> {
  try {
    const db = await getPool();

    // Method 1: Try Session Cookie (Chrome Extension)
    if (session?.cookies) {
      const sessionMatch = session.cookies.match(/JSESSIONID=([^;]+)/);
      if (sessionMatch) {
        // FIXED: Clean Session ID - Remove trailing routing info (e.g., .worker1)
        let sessionId = sessionMatch[1];
        if (sessionId.includes('.')) {
          sessionId = sessionId.split('.')[0];
        }

        console.log('[Auth] Checking Session ID:', sessionId);

        const result = await db.request()
          .input('sessionId', sessionId)
          .query(`
            SELECT TOP 1 
              u.ID as USER_ID, 
              u.USER_NAME
            FROM CMN_SEC_USERS u
            INNER JOIN CMN_SEC_USER_SESSIONS s ON s.USER_ID = u.ID
            WHERE s.SESSION_ID = @sessionId
            AND s.LAST_UPDATED_DATE > DATEADD(hour, -24, GETDATE())
          `);

        if (result.recordset.length > 0) {
          console.log('[Auth] ✅ Authenticated via Cookie:', result.recordset[0].USER_NAME);
          return result.recordset[0].USER_ID.toString();
        }
      }
    }

    // Method 2: Try Username
    if (session?.username) {
      console.log('[Auth] Checking Username:', session.username);
      
      // Try exact match
      let result = await db.request()
        .input('username', session.username)
        .query(`
          SELECT TOP 1 
            ID as USER_ID, 
            USER_NAME
          FROM CMN_SEC_USERS
          WHERE USER_NAME = @username
          AND USER_STATUS_ID = 1
        `);

      if (result.recordset.length > 0) {
        console.log('[Auth] ✅ User found:', result.recordset[0].USER_NAME);
        return result.recordset[0].USER_ID.toString();
      }
      
      // Try case-insensitive match
      result = await db.request()
        .input('username', session.username)
        .query(`
          SELECT TOP 1 
            ID as USER_ID, 
            USER_NAME
          FROM CMN_SEC_USERS
          WHERE LOWER(USER_NAME) = LOWER(@username)
          AND USER_STATUS_ID = 1
        `);

      if (result.recordset.length > 0) {
        console.log('[Auth] ✅ User found (case-insensitive):', result.recordset[0].USER_NAME);
        return result.recordset[0].USER_ID.toString();
      }
      
      // Fallback: Admin user
      // FIXED: Use GROUP_CODE instead of GROUP_NAME to avoid column errors
      console.warn('[Auth] ⚠️ User not found, trying admin fallback');
      result = await db.request()
        .query(`
          SELECT TOP 1 
            u.ID as USER_ID, 
            u.USER_NAME
          FROM CMN_SEC_USERS u
          INNER JOIN CMN_SEC_USER_GROUPS ug ON ug.USER_ID = u.ID
          INNER JOIN CMN_SEC_GROUPS g ON g.ID = ug.GROUP_ID
          WHERE g.GROUP_CODE IN ('Admin', 'ProcessAdmin', 'SystemAdmin')
          AND u.USER_STATUS_ID = 1
        `);
      
      if (result.recordset.length > 0) {
        console.log('[Auth] ⚠️ Using admin fallback:', result.recordset[0].USER_NAME);
        return result.recordset[0].USER_ID.toString();
      }
      
      // Last resort: any active user
      result = await db.request()
        .query(`
          SELECT TOP 1 
            ID as USER_ID, 
            USER_NAME
          FROM CMN_SEC_USERS
          WHERE USER_STATUS_ID = 1
          ORDER BY LAST_UPDATED_DATE DESC
        `);
      
      if (result.recordset.length > 0) {
        console.log('[Auth] ⚠️ Using first active user:', result.recordset[0].USER_NAME);
        return result.recordset[0].USER_ID.toString();
      }
      
      console.error('[Auth] ❌ No active users found in database!');
      return null;
    }

    console.error('[Auth] ❌ No credentials provided');
    return null;
  } catch (error: any) {
    console.error('[Auth] Error:', error.message);
    return null;
  }
}

// Get user permissions for all objects
async function getUserPermissions(userId: string): Promise<UserSession['permissions']> {
  try {
    const db = await getPool();

    // FIXED: Use GROUP_CODE instead of GROUP_NAME to avoid column errors
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
      // Admin has all permissions on all objects
      clarityObjects.forEach((obj) => {
        permissions.set(obj.objectCode, {
          objectCode: obj.objectCode,
          objectName: obj.objectName,
          canRead: true,
          canWrite: true,
          canUpdate: true,
          canDelete: true,
          canExecute: true
        });
      });
      console.log('[Permissions] User is admin - full access to all objects');
      return permissions;
    }

    // Get specific permissions
    const permsResult = await db.request()
      .input('userId', userId)
      .query(`
        SELECT DISTINCT
          ar.OBJECT_CODE,
          MAX(CAST(ar.CAN_READ as INT)) as CAN_READ,
          MAX(CAST(ar.CAN_WRITE as INT)) as CAN_WRITE,
          MAX(CAST(ar.CAN_UPDATE as INT)) as CAN_UPDATE,
          MAX(CAST(ar.CAN_DELETE as INT)) as CAN_DELETE,
          MAX(CAST(ar.CAN_EXECUTE as INT)) as CAN_EXECUTE
        FROM CMN_SEC_ACCESS_RIGHTS ar
        WHERE ar.PRINCIPAL_ID IN (
          SELECT GROUP_ID FROM CMN_SEC_USER_GROUPS WHERE USER_ID = @userId
          UNION
          SELECT @userId
        )
        AND ar.IS_ACTIVE = 1
        GROUP BY ar.OBJECT_CODE
      `);

    permsResult.recordset.forEach((perm: any) => {
      // Map back to known objects
      const knownObj = clarityObjects.get(perm.OBJECT_CODE);
      if (knownObj) {
        permissions.set(perm.OBJECT_CODE, {
          objectCode: perm.OBJECT_CODE,
          objectName: knownObj.objectName,
          canRead: perm.CAN_READ === 1,
          canWrite: perm.CAN_WRITE === 1,
          canUpdate: perm.CAN_UPDATE === 1,
          canDelete: perm.CAN_DELETE === 1,
          canExecute: perm.CAN_EXECUTE === 1
        });
      }
    });

    console.log(`[Permissions] Loaded permissions for ${permissions.size} objects`);
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
  if (!context.objectId) {
    return 'No object ID found on current page';
  }

  const perm = session.permissions.get(context.objectCode);
  if (!perm?.canRead) {
    return `❌ You don't have READ permission for ${context.objectCode}`;
  }

  const obj = clarityObjects.get(context.objectCode);
  if (!obj || !obj.tableName) {
    return `Object ${context.objectCode} not found or has no table`;
  }

  try {
    const db = await getPool();
    
    const query = `SELECT TOP 1 * FROM ${obj.tableName} WITH(NOLOCK) WHERE ${obj.pkColumn} = @id`;
    console.log(`[SQL] ${query}`);
    
    const result = await db.request()
      .input('id', context.objectId)
      .query(query);

    if (result.recordset.length === 0) {
      return `No data found for ${context.objectCode} with ID ${context.objectId}`;
    }

    return JSON.stringify(result.recordset[0], null, 2);

  } catch (error: any) {
    return `Error getting object details: ${error.message}`;
  }
}

// ============================================================================
// GENERIC CRUD EXECUTION - The Core Magic!
// ============================================================================
async function executeGenericCRUD(
  action: string,
  objectCode: string,
  args: any,
  session: UserSession | null
): Promise<string> {
  
  const obj = clarityObjects.get(objectCode.toUpperCase());
  if (!obj || !obj.tableName) {
    return `❌ Object ${objectCode} not found. Use list_objects to see available objects.`;
  }

  // Check permission
  if (session) {
    const perm = session.permissions.get(obj.objectCode);
    if (!perm) {
      return `❌ You don't have any permissions for ${obj.objectName}`;
    }

    switch (action) {
      case 'read':
        if (!perm.canRead) return `❌ No READ permission for ${obj.objectName}`;
        break;
      case 'create':
        if (!perm.canWrite) return `❌ No WRITE permission for ${obj.objectName}`;
        break;
      case 'update':
        if (!perm.canUpdate) return `❌ No UPDATE permission for ${obj.objectName}`;
        break;
      case 'delete':
        if (!perm.canDelete) return `❌ No DELETE permission for ${obj.objectName}`;
        break;
    }
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
        console.log(`[SQL] ${query}`);
        
        const result = await req.query(query);
        
        return result.recordset.length === 0
          ? `No records found`
          : JSON.stringify(result.recordset, null, 2);
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
        
        const query = `INSERT INTO ${obj.tableName} (${cols.join(',')}) VALUES (${vals.join(',')})`;
        console.log(`[SQL] ${query}`);
        
        await req.query(query);
        return `✅ Created new ${obj.objectName}`;
      }

      case 'update': {
        const req = db.request();
        const updates: string[] = [];
        
        Object.entries(args.data).forEach(([key, val], idx) => {
          updates.push(`${key} = @u${idx}`);
          req.input(`u${idx}`, val);
        });
        
        req.input('id', args.id);
        const query = `UPDATE ${obj.tableName} SET ${updates.join(', ')} WHERE ${obj.pkColumn} = @id`;
        
        console.log(`[SQL] ${query}`);
        const result = await req.query(query);
        
        return `✅ Updated ${result.rowsAffected[0]} ${obj.objectName} record(s)`;
      }

      case 'delete': {
        const req = db.request();
        req.input('id', args.id);
        
        const query = `DELETE FROM ${obj.tableName} WHERE ${obj.pkColumn} = @id`;
        console.log(`[SQL] ${query}`);
        
        const result = await req.query(query);
        return `✅ Deleted ${result.rowsAffected[0]} record(s)`;
      }

      default:
        return `Unknown action: ${action}`;
    }

  } catch (error: any) {
    // CRITICAL: Return SQL error to AI so it can self-correct!
    console.error(`[CRUD Error]`, error);
    return `❌ Database Error: ${error.message}

**Hint:** This might be due to incorrect column names. Use the 'get_schema' tool to check the correct column names for ${obj.objectCode} (table: ${obj.tableName}).

Error details: ${error.originalError?.info?.message || error.message}`;
  }
}

// ============================================================================
// DYNAMIC SQL ENGINE (Read-Only) - The Power Feature!
// ============================================================================
async function executeDynamicQuery(sqlQuery: string, session: UserSession | null): Promise<string> {
  // Security: Block destructive operations
  const forbidden = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE'];
  const upperSQL = sqlQuery.toUpperCase().trim();
  
  // Must start with SELECT or WITH (for CTEs)
  if (!upperSQL.startsWith('SELECT') && !upperSQL.startsWith('WITH')) {
    return '❌ Security Error: Only SELECT queries are allowed in dynamic mode.';
  }

  // Check for forbidden keywords
  for (const word of forbidden) {
    if (upperSQL.includes(` ${word} `) || upperSQL.includes(`\n${word} `) || upperSQL.includes(`\t${word} `)) {
      return `❌ Security Error: Destructive command '${word}' not allowed. Use generic_crud for modifications.`;
    }
  }

  try {
    const db = await getPool();
    console.log(`[Dynamic SQL] Executing:\n${sqlQuery}`);
    
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length === 0) {
      return 'Query executed successfully but returned no results.';
    }
    
    if (result.recordset.length > 100) {
      return JSON.stringify(result.recordset.slice(0, 100), null, 2) + 
             `\n\n... (${result.recordset.length} total rows, showing first 100)`;
    }
    
    return JSON.stringify(result.recordset, null, 2);

  } catch (error: any) {
    console.error('[Dynamic SQL] Error:', error);
    return `❌ SQL Error: ${error.message}

**Debugging Tips:**
1. Check table names with 'list_objects'
2. Check column names with 'get_schema'
3. Use table aliases (e.g., SELECT p.NAME FROM INV_INVESTMENTS p)
4. Common tables:
   - Projects: INV_INVESTMENTS
   - Tasks: PRTASK
   - Resources: SRM_RESOURCES
   - Lookups: CMN_LOOKUPS_V

Original Query:
${sqlQuery}`;
  }
}

// ============================================================================
// AI AGENT WITH DYNAMIC SQL
// ============================================================================
async function runAIAgentLoop(
  userMessage: string,
  context: PageContext,
  session: UserSession | null,
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
    return 'AI not configured';
  }

  await loadClarityObjects();

  // Enhanced system prompt with dynamic SQL instructions
  let systemPrompt = `You are a Clarity PPM Expert & SQL Data Analyst with direct database access.

🎯 YOUR CAPABILITIES:
1. **Data Analysis & Complex Queries** (Use run_read_only_sql):
   - "How many active projects?"
   - "Total budget by department"
   - "Top 5 projects over budget"
   - "List resources with >100 hours this month"
   → Write SQL queries yourself!

2. **Simple CRUD** (Use generic_crud):
   - Create single records
   - Update specific fields
   - Delete records
   → Safer for modifications

3. **Schema Discovery** (Use get_schema):
   - ALWAYS check schema before writing SQL
   - Get correct column names
   - Understand data types

🔑 SQL WRITING RULES:
1. **Check schema first**: Use get_schema before writing queries
2. **Use aliases**: SELECT p.name FROM INV_INVESTMENTS p (not SELECT name FROM INV_INVESTMENTS)
3. **Add NOLOCK**: Use WITH(NOLOCK) for performance
4. **Date functions**: GETDATE(), DATEADD(day, -7, GETDATE()), DATEDIFF(day, start, end)
5. **Common aggregations**: COUNT(*), SUM(amount), AVG(cost), MAX(date), MIN(value)
6. **Joins**: Use proper JOIN syntax with table aliases
7. **NULL handling**: Use ISNULL(column, 0) or COALESCE(column, default)

📊 COMMON CLARITY TABLES:
- Projects/Ideas: INV_INVESTMENTS (columns: NAME, CODE, UNIQUE_NAME, MANAGER_ID, PR_START_DATE, PLANNED_COST)
- Tasks: PRTASK (columns: PRNAME, PRPROJECTID, PRSTATUS, PRASSIGNMENTTYPE)
- Resources: SRM_RESOURCES (columns: USER_NAME, FULL_NAME, RESOURCE_ID, EMAIL_ADDRESS)
- Timesheets: PRTIMESHEET (columns: PRRESOURCEID, PRTASKID, PRTOTALACTUAL)
- Lookups: CMN_LOOKUPS_V (for status/type descriptions)

🔐 Current Context:
- Page: ${context.pageType} ${context.objectId ? `(ID: ${context.objectId})` : ''}
- URL: ${context.url}`;

  if (session) {
    const permsCount = session.permissions.size;
    systemPrompt += `
- User: ${session.userName}
- Access: ${session.isAdmin ? '🔑 ADMIN (full access)' : `${permsCount} objects`}`;
  } else {
    systemPrompt += `
- Access: Limited (not authenticated)`;
  }

  systemPrompt += `

💡 EXAMPLES:

Q: "How many active projects?"
A: 
1. get_schema(project) → see IS_ACTIVE column
2. run_read_only_sql("SELECT COUNT(*) as total FROM INV_INVESTMENTS WITH(NOLOCK) WHERE IS_ACTIVE = 1")

Q: "Total budget by manager"
A:
1. get_schema(project) → see MANAGER_ID, PLANNED_COST
2. run_read_only_sql("
   SELECT 
     r.FULL_NAME as Manager,
     COUNT(*) as Projects,
     SUM(p.PLANNED_COST) as TotalBudget
   FROM INV_INVESTMENTS p WITH(NOLOCK)
   JOIN SRM_RESOURCES r WITH(NOLOCK) ON r.ID = p.MANAGER_ID
   WHERE p.IS_ACTIVE = 1
   GROUP BY r.FULL_NAME
   ORDER BY TotalBudget DESC
")

Q: "Update project status"
A: generic_crud(action="update", objectCode="project", id="...", data={STATUS: "Active"})

**Remember**: Dynamic SQL for analysis, generic_crud for modifications!`;

  // Enhanced tool definitions with dynamic SQL
  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_read_only_sql',
        description: 'Execute a raw SELECT SQL query for complex data analysis (aggregations, joins, filtering). Use this for "How many...", "Total...", "List projects where...", etc. CRITICAL: Check schema first!',
        parameters: {
          type: 'object',
          properties: {
            sqlQuery: {
              type: 'string',
              description: 'Complete MS SQL Server SELECT query. Must include table aliases and WITH(NOLOCK) hints for performance.'
            }
          },
          required: ['sqlQuery']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_schema',
        description: 'Get database schema (columns, types, etc.) for ANY Clarity object. ALWAYS use this before creating/updating to ensure correct column names!',
        parameters: {
          type: 'object',
          properties: {
            objectCode: { type: 'string', description: 'Object code like project, task, idea, etc.' }
          },
          required: ['objectCode']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_objects',
        description: 'List all available Clarity objects you can work with',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_current_page_details',
        description: 'Get full details of the object on the current page',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'generic_crud',
        description: 'Perform Create/Read/Update/Delete on ANY Clarity object. Works for native AND custom objects!',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['read', 'create', 'update', 'delete'],
              description: 'What to do'
            },
            objectCode: {
              type: 'string',
              description: 'Object code (e.g., project, task, idea, incident, custom_object)'
            },
            data: {
              type: 'object',
              description: 'Column=Value pairs for create/update. Check schema first!'
            },
            id: {
              type: 'string',
              description: 'Record ID for update/delete'
            },
            where: {
              type: 'object',
              description: 'Filter conditions for read (e.g., {STATUS: "Active"})'
            },
            limit: {
              type: 'number',
              description: 'Max records to return (default 50)'
            }
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
    sendUpdate({ type: 'thinking', data: `Processing... (${iteration}/${MAX_ITERATIONS})` });

    if (AI_PROVIDER === 'openai' && OPENAI_API_KEY) {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: messages,
          tools: tools,
          tool_choice: 'auto'
        })
      });

      const data: any = await response.json();
      
      if (!data.choices?.[0]) {
        throw new Error('Invalid AI response');
      }
      
      const message: any = data.choices[0].message;

      if (message.tool_calls?.length > 0) {
        messages.push(message);

        for (const toolCall of message.tool_calls) {
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments);

          sendUpdate({ type: 'tool', data: `🔧 ${functionName}` });

          try {
            let result = '';

            if (functionName === 'run_read_only_sql') {
              result = await executeDynamicQuery(functionArgs.sqlQuery, session);
            }
            else if (functionName === 'get_schema') {
              result = await getObjectSchema(functionArgs.objectCode);
            }
            else if (functionName === 'list_objects') {
              const available: string[] = [];
              clarityObjects.forEach((obj) => {
                available.push(`${obj.objectCode}: ${obj.objectName} (table: ${obj.tableName})`);
              });
              result = available.join('\n');
            }
            else if (functionName === 'get_current_page_details') {
              if (!context.objectId || !session) {
                result = 'No object on current page or not authenticated';
              } else {
                result = await getPageObjectDetails(context, session);
              }
            }
            else if (functionName === 'generic_crud') {
              result = await executeGenericCRUD(
                functionArgs.action,
                functionArgs.objectCode,
                functionArgs,
                session
              );
            }
            else {
              result = `Unknown tool: ${functionName}`;
            }

            sendUpdate({ type: 'step', data: '✅ Completed' });

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result
            });

          } catch (error: any) {
            sendUpdate({ type: 'step', data: `❌ ${error.message}` });
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: ${error.message}`
            });
          }
        }
        continue;
      }

      if (message.content) {
        sendUpdate({ type: 'complete', data: message.content });
        return message.content;
      }
      break;
    }
  }
  
  return 'Reached maximum iterations';
}

// ============================================================================
// HTTP SERVER
// ============================================================================
async function startHTTPServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3001');
  
  app.use(express.json());
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
  });

  await getPool();
  await loadClarityObjects();

  app.post('/api/chat', async (req, res) => {
    const { message, context, session } = req.body;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendUpdate = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      let userSession: UserSession | null = null;

      if (session) {
        const userId = await getUserFromSession(session);
        
        if (userId) {
          const permissions = await getUserPermissions(userId);
          const isAdmin = Array.from(permissions.values()).every(p => 
            p.canRead && p.canWrite && p.canUpdate && p.canDelete
          );
          
          userSession = {
            userId,
            userName: context.userName || session.username || 'User',
            cookies: session.cookies || '',
            permissions,
            isAdmin
          };

          sendUpdate({ type: 'info', data: `🔐 ${userSession.userName} (${permissions.size} objects, ${isAdmin ? 'ADMIN' : 'User'})` });
        } else {
          sendUpdate({ type: 'warning', data: '⚠️ Authentication failed - using limited access' });
        }
      }

      await runAIAgentLoop(message, context, userSession, sendUpdate);
      
    } catch (error: any) {
      sendUpdate({ type: 'error', data: error.message });
    }

    res.end();
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ready',
      database: pool?.connected ? 'connected' : 'disconnected',
      ai: OPENAI_API_KEY || ANTHROPIC_API_KEY ? 'enabled' : 'disabled',
      objects: clarityObjects.size,
      features: ['schema-discovery', 'generic-crud', 'self-correcting', 'admin-fallback'],
      version: '2.0-enhanced'
    });
  });

  app.listen(PORT, () => {
    console.error(`🚀 Clarity MCP v2.0 - Enhanced with Schema Discovery`);
    console.error(`📡 Chat: http://localhost:${PORT}/api/chat`);
    console.error(`🎯 Objects: ${clarityObjects.size} loaded`);
    console.error(`✅ Features: Schema Discovery | Generic CRUD | Self-Correcting`);
    console.error(`✅ Ready!`);
  });
}

async function main() {
  await startHTTPServer();
}

main().catch(console.error);
