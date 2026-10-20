import type { Config } from './config.js';
import { AppError, record, type JsonRecord } from './util.js';

export class Evolution {
  constructor(private readonly config: Config) {}
  async request(path: string, body?: unknown, method?: 'POST' | 'DELETE'): Promise<unknown> {
    const response = await fetch(`${this.config.EVOLUTION_URL.replace(/\/$/, '')}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { apikey: this.config.EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000), redirect: 'error'
    });
    if (!response.ok) throw new AppError(`evolution_http_${response.status}`, 502, response.status >= 500 || response.status === 429);
    return response.json();
  }
  async messages(instance: string, from: string, to: string, page: number, size = 250): Promise<{ total: number; pages: number; records: unknown[] }> {
    const result = record(await this.request(`/chat/findMessages/${encodeURIComponent(instance)}`, {
      where: { messageTimestamp: { gte: from, lte: to } }, page, offset: size
    }));
    const messages = record(result.messages);
    if (!Array.isArray(messages.records) || typeof messages.total !== 'number' || typeof messages.pages !== 'number') throw new AppError('evolution_contract_invalid', 502);
    return { total: messages.total, pages: messages.pages, records: messages.records };
  }
  async webhook(instance: string): Promise<JsonRecord> { return record(await this.request(`/webhook/find/${encodeURIComponent(instance)}`)); }
  async configureWebhook(instance: string, connectionId: string): Promise<unknown> {
    return this.request(`/webhook/set/${encodeURIComponent(instance)}`, { webhook: {
      enabled: true, url: `http://motor-api:8090/webhooks/evolution/${connectionId}`,
      headers: { 'x-motor-secret': this.config.WEBHOOK_SECRET }, byEvents: false, base64: false,
      events: ['MESSAGES_SET', 'MESSAGES_UPSERT', 'MESSAGES_EDITED', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'SEND_MESSAGE', 'CONNECTION_UPDATE']
    } });
  }
}
