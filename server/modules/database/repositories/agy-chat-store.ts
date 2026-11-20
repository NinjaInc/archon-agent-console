/**
 * Antigravity (agy) chat store: one row per chat plus its messages.
 * agy keeps its own conversation history in files we do not parse, so the console stores
 * what it needs to show a chat again (user text, assistant text, tool steps).
 */

import { getConnection } from '@/modules/database/connection.js';

export type AgyChatRow = {
  chat_id: string;
  project_path: string;
  title: string;
  model: string | null;
  agy_conversation_id: string | null;
  created_at: number;
  updated_at: number;
};

export type AgyChatMessageRow = {
  message_id: number;
  chat_id: string;
  role: string;
  content: string;
  created_at: number;
};

// agyChatDb: used by the agy-chat module's service to persist chats and messages.
export const agyChatDb = {
  insertChat(row: AgyChatRow): void {
    getConnection()
      .prepare('INSERT INTO agy_chats (chat_id, project_path, title, model, agy_conversation_id, created_at, updated_at) VALUES (@chat_id, @project_path, @title, @model, @agy_conversation_id, @created_at, @updated_at)')
      .run(row);
  },
  getChat(chatId: string): AgyChatRow | undefined {
    return getConnection().prepare('SELECT * FROM agy_chats WHERE chat_id = ?').get(chatId) as AgyChatRow | undefined;
  },
  listChats(projectPath: string): AgyChatRow[] {
    return getConnection().prepare('SELECT * FROM agy_chats WHERE project_path = ? ORDER BY updated_at DESC LIMIT 200').all(projectPath) as AgyChatRow[];
  },
  updateChat(chatId: string, fields: Partial<Pick<AgyChatRow, 'title' | 'model' | 'agy_conversation_id' | 'updated_at'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    getConnection()
      .prepare(`UPDATE agy_chats SET ${keys.map((key) => `${key} = @${key}`).join(', ')} WHERE chat_id = @chat_id`)
      .run({ ...fields, chat_id: chatId });
  },
  deleteChat(chatId: string): boolean {
    return getConnection().prepare('DELETE FROM agy_chats WHERE chat_id = ?').run(chatId).changes > 0;
  },
  insertMessage(chatId: string, role: string, content: string, createdAt: number): void {
    getConnection().prepare('INSERT INTO agy_chat_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(chatId, role, content, createdAt);
  },
  listMessages(chatId: string): AgyChatMessageRow[] {
    return getConnection().prepare('SELECT * FROM agy_chat_messages WHERE chat_id = ? ORDER BY message_id ASC LIMIT 5000').all(chatId) as AgyChatMessageRow[];
  },
};
