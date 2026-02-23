#!/usr/bin/env node
/**
 * E2B MCP Gateway
 * Wraps @e2b/mcp-server (stdio) and exposes it as a Letta-compatible
 * streamable HTTP MCP endpoint.
 * 
 * Architecture:
 *   Client (Letta) --HTTP POST--> This server --stdio--> E2B MCP Server
 */

const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8000;
const E2B_API_KEY = process.env.E2B_API_KEY;

if (!E2B_API_KEY) {
  console.error('E2B_API_KEY environment variable is required');
  process.exit(1);
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'e2b-mcp-gateway', version: '1.0.0' });
});

/**
 * Spawn a fresh E2B MCP server process and send one JSON-RPC request,
 * collect the response, then kill the process.
 */
function callMcpServer(request) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [
      require.resolve('@e2b/mcp-server/build/index.js').replace(/\\/g, '/')
    ], {
      env: { ...process.env, E2B_API_KEY },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let initialized = false;
    let requestSent = false;
    let timeoutId;

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        try {
          const msg = JSON.parse(line);
          
          // Handle initialize response
          if (msg.id === 'init' && !initialized) {
            initialized = true;
            // Now send the actual request
            proc.stdin.write(JSON.stringify(request) + '\n');
            requestSent = true;
          }
          // Handle our actual request response
          else if (msg.id === request.id) {
            clearTimeout(timeoutId);
            proc.kill();
            resolve(msg);
          }
        } catch (e) {
          // Not JSON, skip
        }
      }
      stdout = lines[lines.length - 1];
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`MCP server exited with code ${code}: ${stderr}`));
      }
    });

    // Send initialize first
    const initMsg = {
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'letta-gateway', version: '1.0.0' }
      }
    };
    proc.stdin.write(JSON.stringify(initMsg) + '\n');

    timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error('MCP server timeout after 60s'));
    }, 60000);
  });
}

/**
 * Streamable HTTP MCP endpoint
 * Letta sends POST /mcp with JSON-RPC body
 */
app.post('/mcp', async (req, res) => {
  const body = req.body;
  
  // Handle batch requests
  const requests = Array.isArray(body) ? body : [body];
  
  try {
    const responses = await Promise.all(
      requests.map(r => callMcpServer(r))
    );
    
    if (Array.isArray(body)) {
      res.json(responses);
    } else {
      res.json(responses[0]);
    }
  } catch (err) {
    console.error('MCP error:', err);
    res.status(500).json({
      jsonrpc: '2.0',
      id: body.id || null,
      error: { code: -32603, message: err.message }
    });
  }
});

/**
 * SSE endpoint for Letta SSE transport
 */
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send tools list immediately
  const toolsList = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: [{
        name: 'run_code',
        description: 'Run Python code in a secure E2B sandbox. Uses Jupyter Notebook syntax. Returns stdout, stderr, and any outputs.',
        inputSchema: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'Python code to execute in the sandbox'
            }
          },
          required: ['code']
        }
      }]
    }
  };
  
  res.write(`data: ${JSON.stringify(toolsList)}\n\n`);
  
  req.on('close', () => {
    res.end();
  });
});

/**
 * Direct run_code endpoint for simple HTTP calls
 */
app.post('/run', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }
  
  const request = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'tools/call',
    params: {
      name: 'run_code',
      arguments: { code }
    }
  };
  
  try {
    const response = await callMcpServer(request);
    res.json(response.result || response.error);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`E2B MCP Gateway running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP: http://localhost:${PORT}/mcp`);
  console.log(`SSE: http://localhost:${PORT}/sse`);
});
