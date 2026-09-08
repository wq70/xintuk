(function () {
  "use strict";

  const PROTOCOL_VERSIONS = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
  ];
  const BLOCKED_HEADERS = new Set([
    "host",
    "origin",
    "cookie",
    "content-length",
    "accept",
    "content-type",
    "authorization",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
  ]);

  function uid(prefix) {
    const value = globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${value}`;
  }

  function normalizeHeaders(value) {
    if (!value) return {};
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("附加 Headers 必须是 JSON 对象。");
    }
    const headers = {};
    Object.entries(parsed).forEach(([rawName, rawValue]) => {
      const name = String(rawName || "").trim();
      if (!name || BLOCKED_HEADERS.has(name.toLowerCase())) {
        throw new Error(`不允许覆盖请求头 ${name || "（空名称）"}。`);
      }
      if (typeof rawValue !== "string") {
        throw new Error(`请求头 ${name} 的值必须是字符串。`);
      }
      headers[name] = rawValue;
    });
    return headers;
  }

  function parseSseEvents(text) {
    const events = [];
    String(text || "")
      .split(/\r?\n\r?\n/)
      .forEach((block) => {
        if (!block.trim()) return;
        const data = [];
        let id = "";
        let event = "message";
        block.split(/\r?\n/).forEach((line) => {
          if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        });
        if (!data.length) return;
        let payload = data.join("\n");
        try {
          payload = JSON.parse(payload);
        } catch (_) {
          // Diagnostic text is preserved for the activity log.
        }
        events.push({ id, event, data: payload });
      });
    return events;
  }

  function parseResponsePayload(text, contentType, requestId, onMessage) {
    if (!String(text || "").trim()) return null;
    if (String(contentType || "").includes("text/event-stream")) {
      const events = parseSseEvents(text);
      events.forEach((event) => {
        const payload = event.data;
        if (payload && typeof payload === "object" && payload.id !== requestId) {
          onMessage?.(payload, event);
        }
      });
      return (
        events.map((event) => event.data).find((item) => item?.id === requestId) ||
        events.map((event) => event.data).find((item) => item?.result !== undefined || item?.error) ||
        null
      );
    }
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error("服务器返回了无法解析的 MCP 响应。");
    }
  }

  function describeNetworkError(error) {
    if (/Failed to fetch|NetworkError|Load failed/i.test(error?.message || "")) {
      return new Error(
        "浏览器无法访问该端点。请检查 HTTPS、CORS、局域网权限、证书与桥接器状态。",
      );
    }
    return error;
  }

  class HttpMcpClient {
    constructor(options) {
      this.connection = options.connection;
      this.getSecret = options.getSecret || (() => ({}));
      this.getSettings = options.getSettings || (() => ({}));
      this.onMessage = options.onMessage || (() => {});
      this.onSessionChange = options.onSessionChange || (() => {});
      this.streamController = null;
      this.legacyStreamController = null;
      this.legacyReady = null;
      this.legacyMessageEndpoint = "";
      this.legacyPending = new Map();
      this.lastEventId = "";
      this.reconnecting = null;
    }

    async headers(initialized, extra) {
      const connection = this.connection;
      const secret = (await this.getSecret(connection.id)) || {};
      const headers = {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...normalizeHeaders(connection.customHeaders || connection.headers),
      };
      const token = secret.accessToken || secret.secret || "";
      if (["bearer", "oauth"].includes(connection.authType) && token) {
        headers.Authorization = `Bearer ${token}`;
      } else if (["api_key", "custom"].includes(connection.authType) && (connection.headerName || connection.apiKeyHeader) && token) {
        headers[connection.headerName || connection.apiKeyHeader] = token;
      }
      if (initialized && connection.protocolVersion) {
        headers["MCP-Protocol-Version"] = connection.protocolVersion;
      }
      if (initialized && connection.sessionId) {
        headers["Mcp-Session-Id"] = connection.sessionId;
      }
      if (connection.pairingCode) headers["X-MCP-Pairing-Code"] = connection.pairingCode;
      if (extra?.lastEventId) headers["Last-Event-ID"] = extra.lastEventId;
      return headers;
    }

    async rawRequest(method, params, options) {
      const opts = options || {};
      if (this.connection.transport === "sse") {
        return this.legacySseRequest(method, params, opts);
      }
      const requestId = opts.notification ? undefined : uid("rpc");
      const timeoutMs = Math.max(1000, Number(this.getSettings().timeoutMs) || 20000);
      const controller = new AbortController();
      const externalAbort = () => controller.abort();
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener("abort", externalAbort, { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(this.connection.endpoint, {
          method: "POST",
          headers: await this.headers(method !== "initialize"),
          body: JSON.stringify({
            jsonrpc: "2.0",
            ...(requestId === undefined ? {} : { id: requestId }),
            method,
            ...(params === undefined ? {} : { params }),
          }),
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === "AbortError" && opts.signal?.aborted) throw error;
        if (error?.name === "AbortError") {
          const timeoutError = new Error(`连接超时（${Math.round(timeoutMs / 1000)} 秒）。`);
          timeoutError.name = "McpTimeoutError";
          throw timeoutError;
        }
        throw describeNetworkError(error);
      } finally {
        clearTimeout(timeout);
        opts.signal?.removeEventListener("abort", externalAbort);
      }

      if (method === "initialize") {
        this.connection.sessionId = response.headers.get("Mcp-Session-Id") || "";
        this.onSessionChange(this.connection);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(
          `MCP 服务返回 ${response.status}${body ? `：${body.slice(0, 300)}` : ""}`,
        );
        error.status = response.status;
        error.wwwAuthenticate = response.headers.get("WWW-Authenticate") || "";
        error.retryAfter = response.headers.get("Retry-After") || "";
        throw error;
      }
      if (opts.notification || response.status === 202) return null;
      const payload = parseResponsePayload(
        await response.text(),
        response.headers.get("content-type"),
        requestId,
        this.onMessage,
      );
      if (!payload) throw new Error("服务器没有返回对应的 MCP 响应。");
      if (payload.error) {
        const error = new Error(payload.error.message || `MCP 错误 ${payload.error.code || ""}`.trim());
        error.code = payload.error.code;
        error.data = payload.error.data;
        throw error;
      }
      return payload.result;
    }

    handleLegacyEvent(event) {
      if (event.event === "endpoint" && typeof event.data === "string") {
        const endpoint = new URL(event.data, this.connection.endpoint);
        if (!/^https?:$/.test(endpoint.protocol)) throw new Error("SSE 服务返回了不安全的消息端点。");
        if (endpoint.origin !== new URL(this.connection.endpoint, location.href).origin) {
          throw new Error("SSE 消息端点与服务端点不同源，已阻止凭据外发。");
        }
        this.legacyMessageEndpoint = endpoint.href;
        return;
      }
      const payload = event.data;
      const pending = payload && this.legacyPending.get(payload.id);
      if (pending) {
        this.legacyPending.delete(payload.id);
        if (payload.error) {
          const error = new Error(payload.error.message || "MCP SSE 请求失败。");
          error.code = payload.error.code;
          error.data = payload.error.data;
          pending.reject(error);
        } else pending.resolve(payload.result);
      } else if (payload && typeof payload === "object") {
        this.onMessage(payload, event);
      }
    }

    async ensureLegacySse(signal) {
      if (this.legacyMessageEndpoint) return;
      if (!this.legacyReady) {
        this.legacyReady = (async () => {
          this.legacyStreamController = new AbortController();
          const abort = () => this.legacyStreamController.abort();
          signal?.addEventListener("abort", abort, { once: true });
          const response = await fetch(this.connection.endpoint, {
            method: "GET",
            headers: { ...(await this.headers(false)), Accept: "text/event-stream" },
            cache: "no-store",
            signal: this.legacyStreamController.signal,
          });
          if (!response.ok) throw new Error(`SSE 连接返回 ${response.status}。`);
          if (!response.body?.getReader) throw new Error("当前浏览器不支持流式 SSE 响应。");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let resolveEndpoint;
          let rejectEndpoint;
          const endpointReady = new Promise((resolve, reject) => { resolveEndpoint = resolve; rejectEndpoint = reject; });
          (async () => {
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                buffer += decoder.decode(chunk.value, { stream: true });
                const blocks = buffer.split(/\r?\n\r?\n/);
                buffer = blocks.pop() || "";
                parseSseEvents(blocks.join("\n\n")).forEach((event) => {
                  this.handleLegacyEvent(event);
                  if (this.legacyMessageEndpoint) resolveEndpoint();
                });
              }
              if (!this.legacyMessageEndpoint) rejectEndpoint(new Error("SSE 流未提供消息端点。"));
            } catch (error) {
              rejectEndpoint(error);
              this.legacyPending.forEach((pending) => pending.reject(error));
              this.legacyPending.clear();
            } finally {
              signal?.removeEventListener("abort", abort);
            }
          })();
          await endpointReady;
        })().catch((error) => {
          this.legacyReady = null;
          this.legacyMessageEndpoint = "";
          throw describeNetworkError(error);
        });
      }
      await this.legacyReady;
    }

    async legacySseRequest(method, params, options) {
      const opts = options || {};
      await this.ensureLegacySse(opts.signal);
      const requestId = opts.notification ? undefined : uid("rpc");
      const payload = {
        jsonrpc: "2.0",
        ...(requestId === undefined ? {} : { id: requestId }),
        method,
        ...(params === undefined ? {} : { params }),
      };
      let pendingPromise = null;
      let cleanup = () => {};
      if (requestId !== undefined) {
        pendingPromise = new Promise((resolve, reject) => {
          const timeoutMs = Math.max(1000, Number(this.getSettings().timeoutMs) || 20000);
          const timeout = setTimeout(() => {
            this.legacyPending.delete(requestId);
            reject(new Error(`连接超时（${Math.round(timeoutMs / 1000)} 秒）。`));
          }, timeoutMs);
          const abort = () => {
            this.legacyPending.delete(requestId);
            const error = new DOMException("已取消", "AbortError");
            reject(error);
          };
          opts.signal?.addEventListener("abort", abort, { once: true });
          cleanup = () => { clearTimeout(timeout); opts.signal?.removeEventListener("abort", abort); };
          this.legacyPending.set(requestId, { resolve, reject });
        }).finally(cleanup);
      }
      const response = await fetch(this.legacyMessageEndpoint, {
        method: "POST",
        headers: await this.headers(method !== "initialize"),
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: opts.signal,
      });
      if (!response.ok && response.status !== 202) {
        this.legacyPending.delete(requestId);
        cleanup();
        throw new Error(`MCP SSE 消息端点返回 ${response.status}。`);
      }
      return requestId === undefined ? null : pendingPromise;
    }

    async request(method, params, options) {
      const opts = options || {};
      try {
        return await this.rawRequest(method, params, opts);
      } catch (error) {
        const expired = [400, 404, 410].includes(error?.status) && this.connection.sessionId;
        if (!expired || opts.noReconnect || method === "initialize") throw error;
        this.connection.sessionId = "";
        this.connection.protocolVersion = "";
        if (!this.reconnecting) {
          this.reconnecting = this.initialize(opts.signal).finally(() => {
            this.reconnecting = null;
          });
        }
        await this.reconnecting;
        return this.rawRequest(method, params, { ...opts, noReconnect: true });
      }
    }

    async initialize(signal) {
      if (!this.connection.endpoint) throw new Error("请先填写 MCP 端点。");
      let lastError;
      for (const protocolVersion of PROTOCOL_VERSIONS) {
        try {
          const result = await this.rawRequest(
            "initialize",
            {
              protocolVersion,
              capabilities: {
                roots: { listChanged: true },
                sampling: {},
                elicitation: { form: {}, url: {} },
                tasks: {
                  list: {},
                  cancel: {},
                  requests: {
                    sampling: { createMessage: {} },
                    elicitation: { create: {} },
                  },
                },
              },
              clientInfo: { name: "Tuk Phone MCP", version: "1.0.0" },
            },
            { signal },
          );
          if (!result?.protocolVersion) throw new Error("服务器没有返回有效协议版本。");
          Object.assign(this.connection, {
            protocolVersion: result.protocolVersion,
            serverInfo: result.serverInfo || {},
            serverCapabilities: result.capabilities || {},
            instructions: result.instructions || "",
          });
          await this.rawRequest("notifications/initialized", undefined, {
            notification: true,
            signal,
          });
          this.onSessionChange(this.connection);
          return result;
        } catch (error) {
          lastError = error;
          this.connection.sessionId = "";
          this.connection.protocolVersion = "";
          if (![400, 404, 405, 406].includes(error?.status) && error?.code !== -32602) break;
        }
      }
      if (
        this.connection.transport === "auto" &&
        [404, 405, 406].includes(lastError?.status)
      ) {
        this.connection.transport = "sse";
        return this.initialize(signal);
      }
      throw lastError || new Error("MCP 初始化失败。");
    }

    async listPaged(method, key, signal, maximum) {
      let cursor;
      const seen = new Set();
      const items = [];
      const limit = Math.max(1, Number(maximum) || 2000);
      do {
        const result = await this.request(method, cursor ? { cursor } : {}, { signal });
        items.push(...(Array.isArray(result?.[key]) ? result[key] : []));
        cursor = result?.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error(`${method} 返回了重复分页游标。`);
        if (cursor) seen.add(cursor);
      } while (cursor && items.length < limit);
      return items.slice(0, limit);
    }

    async discover(signal) {
      const declared = this.connection.serverCapabilities || {};
      const specs = [
        ["tools", "tools/list", "tools", "tools"],
        ["resources", "resources/list", "resources", "resources"],
        ["resourceTemplates", "resources/templates/list", "resourceTemplates", "resources"],
        ["prompts", "prompts/list", "prompts", "prompts"],
      ];
      const result = { tools: [], resources: [], resourceTemplates: [], prompts: [], errors: {} };
      await Promise.all(
        specs.map(async ([name, method, key, declaredKey]) => {
          if (Object.keys(declared).length && !declared[declaredKey]) return;
          try {
            result[name] = await this.listPaged(method, key, signal);
          } catch (error) {
            result.errors[name] = error?.message || String(error);
          }
        }),
      );
      this.connection.capabilities = result;
      return result;
    }

    async sendResponse(id, result, rpcError) {
      if (id === undefined || id === null) return;
      if (this.connection.transport === "sse") await this.ensureLegacySse();
      const response = await fetch(this.connection.transport === "sse" ? this.legacyMessageEndpoint : this.connection.endpoint, {
        method: "POST",
        headers: await this.headers(true),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          ...(rpcError ? { error: rpcError } : { result }),
        }),
        cache: "no-store",
      });
      if (!response.ok && response.status !== 202) {
        throw new Error(`MCP 响应回传失败：${response.status}`);
      }
    }

    async openEventStream(signal) {
      if (this.connection.transport === "sse") {
        await this.ensureLegacySse(signal);
        return true;
      }
      this.streamController?.abort();
      this.streamController = new AbortController();
      const externalAbort = () => this.streamController.abort();
      signal?.addEventListener("abort", externalAbort, { once: true });
      try {
        const response = await fetch(this.connection.endpoint, {
          method: "GET",
          headers: await this.headers(true, { lastEventId: this.lastEventId }),
          cache: "no-store",
          signal: this.streamController.signal,
        });
        if ([404, 405].includes(response.status)) return false;
        if (!response.ok) throw new Error(`服务器事件流返回 ${response.status}。`);
        if (!response.body?.getReader) return false;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || "";
          parseSseEvents(blocks.join("\n\n")).forEach((event) => {
            if (event.id) this.lastEventId = event.id;
            this.onMessage(event.data, event);
          });
        }
        return true;
      } finally {
        signal?.removeEventListener("abort", externalAbort);
      }
    }

    async close() {
      this.streamController?.abort();
      this.legacyStreamController?.abort();
      this.legacyStreamController = null;
      this.legacyReady = null;
      this.legacyMessageEndpoint = "";
      this.legacyPending.forEach((pending) => pending.reject(new Error("MCP 连接已关闭。")));
      this.legacyPending.clear();
      if (!this.connection.sessionId) return;
      try {
        await fetch(this.connection.endpoint, {
          method: "DELETE",
          headers: await this.headers(true),
          cache: "no-store",
        });
      } catch (_) {
        // Session cleanup is best effort.
      }
      this.connection.sessionId = "";
      this.onSessionChange(this.connection);
    }
  }

  window.TukMcpProtocol = {
    PROTOCOL_VERSIONS,
    HttpMcpClient,
    normalizeHeaders,
    parseSseEvents,
    uid,
  };
})();
