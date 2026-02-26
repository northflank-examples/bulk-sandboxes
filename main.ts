import {
  ApiClient,
  ApiClientInMemoryContextProvider,
} from "@northflank/js-client";
import https from "https";
import Bottleneck from "bottleneck";

const API_HOST = "https://api.northflank.com";
const TOTAL_SERVICES = Number(process.env.TOTAL_SERVICES || 10000);
const CREATE_CONCURRENCY = Number(process.env.CREATE_CONCURRENCY || 100);
const DELETE_CONCURRENCY = Number(process.env.TOTAL_SERVICES || 50);
const DEPLOYMENT_PLAN = process.env.DEPLOYMENT_PLAN || "nf-compute-10";
const PROJECT_ID = process.env.PROJECT_ID || "";
const CLEANUP = process.argv.includes("--cleanup");

const DELAY_ON_RATE_LIMIT_MS = 5000;
const MAX_FAILURE_LOGS = 100;

const INTERNAL_IMAGE = {
  internal: {
    id: "internal",
    branch: "main",
  },
};

const EXTERNAL_IMAGE = {
  external: {
    imagePath:
      "283492384.dkr.ecr.us-east-2.amazonaws.com/your-image/goes/here:latest",
    credentials: "ecr-credentials", // You can add your custom ECR credentials in the platform on the team level under Integrations > Registries
  },
};

// You can swap between internal (Northflank build services) and external images (e.g. ECR service)
const image = INTERNAL_IMAGE;

interface Stats {
  created: number;
  createFailed: number;
  startTime: number;
}

interface FailureLog {
  serviceId: string;
  error: string;
  timestamp: number;
}

const createTimings: number[] = [];
const failureLogs: FailureLog[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function generateId(): string {
  return `${Date.now()}-${crypto.randomUUID().substring(0, 8)}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function logFailure(failure: FailureLog): void {
  failureLogs.push(failure);
  if (failureLogs.length > MAX_FAILURE_LOGS) {
    failureLogs.shift();
  }
}

function printRecentFailures(count: number = 10): void {
  if (failureLogs.length === 0) return;

  console.log(
    `\nRecent failures (last ${Math.min(count, failureLogs.length)} of ${failureLogs.length}):`,
  );
  const recent = failureLogs.slice(-count);

  for (const f of recent) {
    const time = new Date(f.timestamp).toISOString().slice(11, 19);
    console.log(`  [${time}] ${f.serviceId}`);
    console.log(`           Error: ${f.error}`);
  }
}

function printProgress(stats: Stats): void {
  const elapsed = Date.now() - stats.startTime;
  const elapsedSec = elapsed / 1000;
  const createRate = stats.created / elapsedSec;
  const pct = ((stats.created / TOTAL_SERVICES) * 100).toFixed(1);

  process.stdout.write(
    `\r[${pct}%] ` +
      `Created: ${stats.created}/${TOTAL_SERVICES} | ` +
      `Failed: ${stats.createFailed} | ` +
      `Rate: ${createRate.toFixed(1)}/s | ` +
      `${formatDuration(elapsed)}   `,
  );
}

function printTimingStats(): void {
  if (createTimings.length === 0) return;

  console.log("\n" + "=".repeat(75));
  console.log("TIMING STATISTICS");
  console.log("=".repeat(75));
  console.log(`Successful services: ${createTimings.length}`);
  console.log("");
  console.log(
    `Create (ms):         ` +
      `avg=${mean(createTimings).toFixed(0)} ` +
      `std=${stddev(createTimings).toFixed(0)} ` +
      `min=${Math.min(...createTimings)} ` +
      `max=${Math.max(...createTimings)} ` +
      `p50=${percentile(createTimings, 50)} ` +
      `p95=${percentile(createTimings, 95)} ` +
      `p99=${percentile(createTimings, 99)}`,
  );
  console.log("=".repeat(75));
}

async function deleteService(
  api: ApiClient,
  projectId: string,
  serviceId: string,
  maxRetries = 3,
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await api.delete.service({
        parameters: { projectId, serviceId },
      });

      if (res.error) {
        const status = res.error.status;

        if (status === 429) {
          await sleep(DELAY_ON_RATE_LIMIT_MS);
          continue;
        }

        if (status === 404) {
          return { success: true };
        }

        if (status === 409) {
          await sleep(2000);
          continue;
        }

        if (attempt === maxRetries) {
          return { success: false, error: res.error.message ?? `HTTP ${status}` };
        }

        await sleep(1000);
        continue;
      }

      return { success: true };
    } catch (error) {
      const err = error as { message?: string };
      if (attempt === maxRetries) {
        return { success: false, error: err.message ?? "Unknown error" };
      }
      await sleep(1000);
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

async function listServices(
  api: ApiClient,
  projectId: string,
): Promise<{ id: string; name: string }[]> {
  const allServices: { id: string; name: string }[] = [];
  let cursor: string | undefined;
  let page = 1;

  console.log(`Listing all services in project ${projectId}...`);

  while (true) {
    const options: { per_page: number; cursor?: string } = { per_page: 100 };
    if (cursor) {
      options.cursor = cursor;
    }

    const res = await api.list.services({
      parameters: { projectId },
      options,
    });

    if (res.error) {
      if (res.error.status === 429) {
        console.log(
          `  Rate limited on page ${page}, waiting ${DELAY_ON_RATE_LIMIT_MS}ms...`,
        );
        await sleep(DELAY_ON_RATE_LIMIT_MS);
        continue;
      }
      throw new Error(res.error.message ?? `HTTP ${res.error.status}`);
    }

    const services = res.data?.services ?? [];
    if (!services.length) break;

    allServices.push(...services.map((s) => ({ id: s.id, name: s.name })));
    console.log(
      `  Page ${page}: ${services.length} services (${allServices.length} total)`,
    );

    const pagination = res.pagination;
    if (!pagination?.hasNextPage) break;

    cursor = pagination.cursor;
    page++;
    await sleep(200);
  }

  return allServices;
}

const deleteLimiter = new Bottleneck({
  maxConcurrent: DELETE_CONCURRENCY,
  minTime: 10,
});

async function cleanup(api: ApiClient, projectId: string): Promise<void> {
  console.log(`Deleting all services in project ${projectId}...\n`);

  const startTime = Date.now();

  const allServices = await listServices(api, projectId);
  const toDelete = allServices.filter(
    (svc) =>
      svc.name !== INTERNAL_IMAGE.internal.id &&
      svc.id !== INTERNAL_IMAGE.internal.id,
  );
  const skipped = allServices.length - toDelete.length;
  if (skipped > 0) {
    console.log(
      `Skipping ${skipped} protected service(s) (${INTERNAL_IMAGE.internal.id}).`,
    );
  }
  console.log(`Found ${toDelete.length} services to delete.\n`);

  if (toDelete.length === 0) return;

  let deleted = 0;
  let failed = 0;

  await Promise.all(
    toDelete.map((svc) =>
      deleteLimiter.schedule(async () => {
        const result = await deleteService(api, projectId, svc.id);

        if (result.success) deleted++;
        else failed++;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate =
          deleted > 0
            ? ((deleted / (Date.now() - startTime)) * 1000 * 60).toFixed(0)
            : "0";
        process.stdout.write(
          `\r[${elapsed}s] Deleted: ${deleted}/${toDelete.length} | Failed: ${failed} | Rate: ${rate}/min   `,
        );

        return result;
      }),
    ),
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\n\nCleanup complete: ${deleted} deleted, ${failed} failed in ${elapsed}s`,
  );
}

async function createService(
  api: ApiClient,
  projectId: string,
  stats: Stats,
): Promise<boolean> {
  const serviceId = `svc-${generateId()}`;
  const createStartMs = Date.now();

  try {
    const res = await api.create.service.deployment({
      parameters: { projectId },
      data: {
        name: serviceId,
        billing: { deploymentPlan: DEPLOYMENT_PLAN },
        deployment: {
          instances: 1,
          ...image,
        },
        ports: [
          {
            name: "http",
            internalPort: 80,
            protocol: "HTTP",
            public: true,
          },
        ],
        runtimeEnvironment: {},
      },
    });

    const createDurationMs = Date.now() - createStartMs;

    if (res.error) {
      stats.createFailed++;
      logFailure({
        serviceId,
        error: JSON.stringify(res.error),
        timestamp: Date.now(),
      });
      return false;
    }

    stats.created++;
    createTimings.push(createDurationMs);
    return true;
  } catch (err) {
    stats.createFailed++;
    logFailure({
      serviceId,
      error: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    });
    return false;
  }
}

async function confirm(): Promise<boolean> {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question("\nProceed? (y/N): ", (answer: string) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

async function main(): Promise<void> {
  const token = process.env.NORTHFLANK_API_TOKEN ?? process.env.TOKEN;
  if (!token) {
    console.error(
      "Error: NORTHFLANK_API_TOKEN environment variable is required",
    );
    process.exit(1);
  }

  if (!PROJECT_ID) {
    console.error("Error: PROJECT_ID environment variable is required");
    process.exit(1);
  }

  console.log("=".repeat(75));
  console.log("Bulk Service Creation Stress Test");
  console.log("=".repeat(75));
  console.log(`Target API:          ${API_HOST}`);
  console.log(`Total services:      ${TOTAL_SERVICES}`);
  console.log(`Project:             ${PROJECT_ID}`);
  console.log(`Create concurrency:  ${CREATE_CONCURRENCY}`);
  console.log(`Deployment plan:     ${DEPLOYMENT_PLAN}`);
  console.log(`Cleanup services:      ${CLEANUP}`);
  console.log("=".repeat(75));

  const confirmed = await confirm();
  if (!confirmed) {
    console.log("Aborted.");
    process.exit(0);
  }

  const httpsAgent = new https.Agent({
    keepAlive: true,
    maxFreeSockets: CREATE_CONCURRENCY,
  });

  const contextProvider = new ApiClientInMemoryContextProvider();
  await contextProvider.addContext({
    name: "default",
    token,
    host: API_HOST,
  });

  const api = new ApiClient(contextProvider, { agent: httpsAgent });
  const createLimiter = new Bottleneck({
    maxConcurrent: CREATE_CONCURRENCY,
    minTime: 10,
  });

  const stats: Stats = {
    created: 0,
    createFailed: 0,
    startTime: Date.now(),
  };

  process.on("SIGINT", () => {
    console.log("\n\nInterrupted!");
    httpsAgent.destroy();
    process.exit(1);
  });

  try {
    if (CLEANUP) {
      console.log("\nCleaning up existing services...");
      await cleanup(api, PROJECT_ID);
    }

    console.log(`\nCreating ${TOTAL_SERVICES} services...\n`);

    const createPromises: Promise<boolean>[] = [];

    const progressInterval = setInterval(() => {
      printProgress(stats);
    }, 500);

    for (let i = 0; i < TOTAL_SERVICES; i++) {
      createPromises.push(
        createLimiter.schedule(() => createService(api, PROJECT_ID, stats)),
      );
    }

    await Promise.all(createPromises);

    clearInterval(progressInterval);
    printProgress(stats);

    const totalElapsed = Date.now() - stats.startTime;
    const successRate = ((stats.created / TOTAL_SERVICES) * 100).toFixed(1);

    console.log("\n\n" + "=".repeat(75));
    console.log("COMPLETE");
    console.log("=".repeat(75));
    console.log(`Project ID:           ${PROJECT_ID}`);
    console.log(`Services created:     ${stats.created}`);
    console.log(`Create failures:      ${stats.createFailed}`);
    console.log(`Success rate:         ${successRate}%`);
    console.log(`Total time:           ${formatDuration(totalElapsed)}`);
    console.log(
      `Create rate:          ${(stats.created / (totalElapsed / 1000)).toFixed(1)}/second`,
    );
    console.log("=".repeat(75));

    if (createTimings.length > 0) {
      printTimingStats();
    }

    if (stats.createFailed > 0) {
      printRecentFailures(20);
    }
  } catch (err) {
    console.error("\nFatal error:", err);
    process.exit(1);
  } finally {
    httpsAgent.destroy();
  }
}

main().catch(console.error);
