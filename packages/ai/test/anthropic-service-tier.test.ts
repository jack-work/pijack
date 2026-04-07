import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model } from "../src/types.ts";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

function createModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
	};
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

async function captureAnthropicRequest(
	apiKey: string,
	overrideServiceTier?: "auto" | "standard_only",
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;

	const server = createServer(async (request, response) => {
		capturedRequest = {
			headers: request.headers,
			body: await readRequestBody(request),
		};
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		const stream = streamAnthropic(createModel(`http://127.0.0.1:${address.port}`), createContext(), {
			apiKey,
			cacheRetention: "none",
			...(overrideServiceTier !== undefined ? { serviceTier: overrideServiceTier } : {}),
		});

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	if (!capturedRequest) {
		throw new Error("Anthropic request was not captured");
	}
	return capturedRequest;
}

describe("Anthropic service_tier injection", () => {
	it("sets service_tier=auto for OAuth (sk-ant-oat) tokens", async () => {
		const request = await captureAnthropicRequest("sk-ant-oat-fake-token");
		expect(request.body.service_tier).toBe("auto");
	});

	it("omits service_tier for plain API keys", async () => {
		const request = await captureAnthropicRequest("sk-ant-api-key");
		expect(request.body.service_tier).toBeUndefined();
	});

	it("respects explicit serviceTier override over OAuth default", async () => {
		const request = await captureAnthropicRequest("sk-ant-oat-fake-token", "standard_only");
		expect(request.body.service_tier).toBe("standard_only");
	});

	it("respects explicit serviceTier override even without OAuth", async () => {
		const request = await captureAnthropicRequest("sk-ant-api-key", "auto");
		expect(request.body.service_tier).toBe("auto");
	});
});
