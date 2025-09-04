const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const ASSEMBLY_API_KEY = "48ad57f589ef4dd38dacf5fcd8ba6c33";

const connections = new Map();
const sseClients = new Map();

app.post('/create-connection', (req, res) => {
  const connectionId = Date.now().toString();
  const { 
    punctuate = true, 
    format_text = true, 
    disfluencies = false,
    speaker_labels = true 
  } = req.body;
  
  // Build endpoint URL with parameters
  const params = new URLSearchParams({
    sample_rate: '16000',
    format_turns: 'true',
    punctuate: punctuate.toString(),
    format_text: format_text.toString(),
    disfluencies: disfluencies.toString(),
    speaker_labels: speaker_labels.toString()
  });
  
  const endpoint = `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
  
  try {
    const ws = new WebSocket(endpoint, {
      headers: { 'Authorization': ASSEMBLY_API_KEY }
    });

    ws.on('open', () => {
      console.log(`Connection ${connectionId} opened with punctuation: ${punctuate}`);
      connections.set(connectionId, ws);
      res.json({ 
        success: true, 
        connectionId: connectionId,
        message: 'WebSocket connection created with punctuation support'
      });
    });

    ws.on('message', (data) => {
      const message = data.toString();
      console.log(`Message from AssemblyAI: ${message}`);
      
      const sseClient = sseClients.get(connectionId);
      if (sseClient) {
        sseClient.write(`data: ${message}\n\n`);
      }
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for connection ${connectionId}:`, error);
      connections.delete(connectionId);
    });

    ws.on('close', () => {
      console.log(`Connection ${connectionId} closed`);
      connections.delete(connectionId);
      
      const sseClient = sseClients.get(connectionId);
      if (sseClient) {
        sseClient.end();
        sseClients.delete(connectionId);
      }
    });

  } catch (error) {
    console.error('Error creating WebSocket connection:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create WebSocket connection' 
    });
  }
});

app.post('/send-audio/:connectionId', (req, res) => {
  const { connectionId } = req.params;
  const { audioData } = req.body;

  const ws = connections.get(connectionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(400).json({ 
      success: false, 
      error: 'WebSocket connection not found or closed' 
    });
  }

  try {
    const audioBuffer = Buffer.from(audioData, 'base64');
    ws.send(audioBuffer);
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending audio data:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to send audio data' 
    });
  }
});

app.get('/events/:connectionId', (req, res) => {
  const { connectionId } = req.params;
  console.log(`SSE connection requested for connectionId: ${connectionId}`);
  
  const ws = connections.get(connectionId);
  if (!ws) {
    console.log(`WebSocket connection ${connectionId} not found`);
    return res.status(404).json({ error: 'WebSocket connection not found' });
  }
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  sseClients.set(connectionId, res);
  console.log(`SSE client connected for connectionId: ${connectionId}`);
  
  res.write(`data: {"type": "connected", "connectionId": "${connectionId}"}\n\n`);
  
  req.on('close', () => {
    console.log(`SSE client disconnected for connection ${connectionId}`);
    sseClients.delete(connectionId);
  });
});

app.delete('/close-connection/:connectionId', (req, res) => {
  const { connectionId } = req.params;
  const ws = connections.get(connectionId);

  if (ws) {
    ws.close();
    connections.delete(connectionId);
    
    const sseClient = sseClients.get(connectionId);
    if (sseClient) {
      sseClient.end();
      sseClients.delete(connectionId);
    }
    
    res.json({ success: true, message: 'Connection closed' });
  } else {
    res.status(404).json({ 
      success: false, 
      error: 'Connection not found' 
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    activeConnections: connections.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/test', (req, res) => {
  res.json({ 
    message: 'Proxy server is running!',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📡 Ready to proxy WebSocket connections to AssemblyAI`);
  console.log(`🔑 Using API Key: ${ASSEMBLY_API_KEY.substring(0, 8)}...`);
});