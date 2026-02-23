/**
 * Garza Matrix-Letta Bridge
 * Connects @garza-lord:lrl.chat to Letta's Garza Lord agent
 * Messages from @jadengarza:beeper.com → Letta → reply back to Matrix
 */

import * as sdk from 'matrix-js-sdk';
import express from 'express';

const LETTA_API_KEY   = process.env.LETTA_API_KEY!;
const LETTA_AGENT_ID  = process.env.LETTA_AGENT_ID!;
const HOMESERVER_URL  = process.env.MATRIX_HOMESERVER_URL!;
const MATRIX_USERNAME = process.env.MATRIX_USERNAME!;
const MATRIX_PASSWORD = process.env.MATRIX_PASSWORD!;
const OWNER_MXID      = process.env.OWNER_MXID || '@jadengarza:beeper.com';
const BOT_NAME        = process.env.BOT_DISPLAY_NAME || 'Garza AI';
const PORT            = parseInt(process.env.PORT || '3000');

// ── health server ───────────────────────────────────────────────
const app = express();
app.get('/health', (_, res) => res.json({ status: 'healthy', service: 'lettabot-matrix' }));
app.listen(PORT, () => console.log(`Health: http://0.0.0.0:${PORT}/health`));

// ── Letta helper ────────────────────────────────────────────────
async function askLetta(message: string): Promise<string> {
  const res = await fetch(`https://app.letta.com/v1/agents/${LETTA_AGENT_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LETTA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: message }],
    }),
  });
  if (!res.ok) throw new Error(`Letta ${res.status}: ${await res.text()}`);
  const data: any = await res.json();

  // Extract assistant_message from response
  const messages = data.messages ?? [];
  for (const msg of messages) {
    if (msg.message_type === 'assistant_message' || msg.assistant_message) {
      return msg.assistant_message ?? msg.content ?? '';
    }
  }
  // fallback: join all tool_return texts
  const fallback = messages
    .filter((m: any) => m.tool_return)
    .map((m: any) => m.tool_return)
    .join('\n');
  return fallback || '(no response)';
}

// ── Matrix bridge ───────────────────────────────────────────────
let client: sdk.MatrixClient;
let myUserId = '';
const processed = new Set<string>();

async function login(): Promise<sdk.MatrixClient> {
  console.log(`Logging in as @${MATRIX_USERNAME} on ${HOMESERVER_URL}`);
  const loginClient = sdk.createClient({ baseUrl: HOMESERVER_URL });

  const resp = await loginClient.login('m.login.password', {
    identifier: { type: 'm.id.user', user: MATRIX_USERNAME },
    password: MATRIX_PASSWORD,
  });
  console.log(`Logged in: ${resp.user_id}`);

  return sdk.createClient({
    baseUrl: HOMESERVER_URL,
    accessToken: resp.access_token,
    userId: resp.user_id,
    deviceId: resp.device_id,
  });
}

async function ensureDmRoom(matrixClient: sdk.MatrixClient): Promise<string> {
  // Check existing joined rooms for DM with owner
  const rooms = matrixClient.getRooms();
  for (const room of rooms) {
    const members = room.getJoinedMembers();
    const mxids = members.map(m => m.userId);
    if (mxids.includes(OWNER_MXID) && mxids.includes(myUserId) && members.length === 2) {
      console.log(`Found existing DM room: ${room.roomId}`);
      return room.roomId;
    }
  }

  // Create new DM
  console.log(`Creating DM room with ${OWNER_MXID}`);
  const created = await matrixClient.createRoom({
    is_direct: true,
    preset: sdk.Preset.TrustedPrivateChat,
    invite: [OWNER_MXID],
    name: BOT_NAME,
  });
  console.log(`Created DM room: ${created.room_id}`);
  return created.room_id;
}

async function sendMessage(roomId: string, text: string): Promise<string> {
  const res = await client.sendMessage(roomId, {
    msgtype: 'm.text',
    body: text,
  });
  return res.event_id;
}

async function editMessage(roomId: string, eventId: string, newText: string) {
  await client.sendMessage(roomId, {
    msgtype: 'm.text',
    body: `* ${newText}`,
    'm.new_content': { msgtype: 'm.text', body: newText },
    'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
  });
}

async function handleMessage(roomId: string, event: sdk.MatrixEvent) {
  const sender  = event.getSender();
  const content = event.getContent();
  const eventId = event.getId()!;

  // Only handle text messages from owner, skip our own
  if (sender !== OWNER_MXID) return;
  if (content.msgtype !== 'm.text') return;
  if (processed.has(eventId)) return;
  processed.add(eventId);
  // Trim processed set
  if (processed.size > 500) {
    const first = processed.values().next().value;
    if (first) processed.delete(first);
  }

  const text = content.body?.trim();
  if (!text) return;

  console.log(`[${sender}] ${text}`);

  // Send typing indicator
  await client.sendTyping(roomId, true, 30000).catch(() => {});

  // Send thinking placeholder
  const thinkingId = await sendMessage(roomId, '⌛ thinking...');

  try {
    const reply = await askLetta(text);
    await editMessage(roomId, thinkingId, reply);
    console.log(`→ replied: ${reply.slice(0, 80)}`);
  } catch (err: any) {
    await editMessage(roomId, thinkingId, `⚠️ Error: ${err.message}`);
    console.error('Letta error:', err.message);
  } finally {
    await client.sendTyping(roomId, false, 0).catch(() => {});
  }
}

async function startBridge() {
  client = await login();
  myUserId = client.getUserId()!;

  // Start client to sync room state
  await client.startClient({ initialSyncLimit: 10 });

  await new Promise<void>(resolve => {
    client.once(sdk.ClientEvent.Sync, (state) => {
      if (state === 'PREPARED') resolve();
    });
  });

  console.log('Matrix client synced');

  const dmRoomId = await ensureDmRoom(client);
  console.log(`Watching room: ${dmRoomId}`);

  // Send online message
  await sendMessage(dmRoomId, `👋 *${BOT_NAME}* is online. Send me anything!`);

  // Listen for new messages
  client.on(sdk.RoomEvent.Timeline, async (event, room) => {
    if (!room) return;
    if (room.roomId !== dmRoomId) return;
    if (event.getType() !== 'm.room.message') return;
    if (event.isRedacted()) return;
    if (event.status === sdk.EventStatus.SENDING) return;

    await handleMessage(room.roomId, event).catch(err =>
      console.error('handleMessage error:', err)
    );
  });

  console.log('Bridge running. Waiting for messages...');
}

// ── main ────────────────────────────────────────────────────────
async function main() {
  while (true) {
    try {
      await startBridge();
      // startBridge runs forever via event listeners
      await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
    } catch (err: any) {
      console.error('Bridge crashed:', err.message);
      console.log('Restarting in 15s...');
      try { client?.stopClient(); } catch {}
      await new Promise(r => setTimeout(r, 15_000));
    }
  }
}

main();
