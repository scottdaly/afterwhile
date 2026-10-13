import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { APP_NAME } from "../../shared/src/index.ts";
import { RecordDatabase } from "./database.ts";
import { formatRecords } from "./format.ts";
import { log } from "./log.ts";

export function createMcpServer(db: RecordDatabase): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: "0.1.0" },
    {
      instructions: `Records ${APP_NAME} saved from web apps on this computer. Cite the source URL with every record you use.`,
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search saved records",
      description:
        "Find saved records by words. Returns the newest matches first, each with its source URL. Optional filters: connection, sourceId, since, until, limit (default 20).",
      inputSchema: {
        query: z.string().describe("Words to find"),
        connection: z.string().optional().describe("Connection id, such as slack"),
        sourceId: z.string().optional().describe("Exact source id"),
        since: z.string().optional().describe("ISO time, inclusive"),
        until: z.string().optional().describe("ISO time, inclusive"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: formatRecords(
            db.search(args.query, {
              connection: args.connection,
              sourceId: args.sourceId,
              since: args.since,
              until: args.until,
              limit: args.limit,
            }),
            args.query,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "recent",
    {
      title: "Recent saved records",
      description:
        "Records for a source or connection. Pass since as an ISO time, or checkpoint true to receive only records saved since this client last asked, then advance that client's checkpoint. client defaults to the MCP client name.",
      inputSchema: {
        sourceId: z.string().optional(),
        connection: z.string().optional(),
        since: z.string().optional().describe("ISO time"),
        checkpoint: z.boolean().optional(),
        client: z.string().optional().describe("Checkpoint name. Defaults to the MCP client name."),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => {
      const client = args.client || server.server.getClientVersion()?.name || "unknown";
      const records = db.recent({
        sourceId: args.sourceId,
        connection: args.connection,
        since: args.since,
        checkpoint: args.checkpoint,
        client: args.checkpoint ? client : undefined,
        limit: args.limit,
      });
      return { content: [{ type: "text", text: formatRecords(records) }] };
    },
  );

  server.registerTool(
    "get",
    {
      title: "Get a source",
      description: "The saved records of one source, in order. Optional from/to position or since/until time.",
      inputSchema: {
        sourceId: z.string(),
        fromPosition: z.number().optional(),
        toPosition: z.number().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: formatRecords(
            db.getSource(args.sourceId, {
              fromPosition: args.fromPosition,
              toPosition: args.toPosition,
              since: args.since,
              until: args.until,
            }),
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "sources",
    {
      title: "List sources",
      description: "Each saved source with title, URL, record count, last capture time, and a coverage summary.",
      inputSchema: {
        connection: z.string().optional(),
      },
    },
    async (args) => {
      const sources = db.sources(args.connection);
      if (sources.length === 0) {
        return { content: [{ type: "text", text: "No sources saved yet." }] };
      }
      const text = sources
        .map((source) => {
          const coverage = source.coverage
            ? `${source.coverage.complete ? "complete" : "partial"}${source.coverage.reason ? ` (${source.coverage.reason})` : ""}`
            : "no coverage row";
          return [
            source.title,
            source.url,
            `id ${source.sourceId}`,
            `records ${source.recordCount}`,
            `last ${source.lastCaptured}`,
            `coverage ${coverage}`,
          ].join("\n");
        })
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "coverage",
    {
      title: "Coverage of a source",
      description: "How complete a source is, plus a plain-words hint about what is missing.",
      inputSchema: {
        sourceId: z.string(),
      },
    },
    async (args) => ({ content: [{ type: "text", text: db.coverageText(args.sourceId) }] }),
  );

  return server;
}

export async function runMcp(): Promise<void> {
  const db = RecordDatabase.openDefault();
  const server = createMcpServer(db);
  const transport = new StdioServerTransport();
  log("mcp listening");
  await server.connect(transport);
}
