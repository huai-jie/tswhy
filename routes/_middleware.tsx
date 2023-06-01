import { MiddlewareHandler } from "$fresh/server.ts";
import { BUILD_ID, DEBUG } from "$fresh/src/server/constants.ts";

const freshAssetPattern = new URLPattern({
  pathname: `/_frsh/js/${BUILD_ID}/:chunkName`,
});

// Fresh Middleware

export const handler: MiddlewareHandler[] = [
  async function (req, ctx) {
    const match = freshAssetPattern.exec(req.url);

    // Handle only JS assets
    if (!match || !match.pathname.groups.chunkName) {
      return ctx.next();
    }

    const { chunkName } = match.pathname.groups;
    const cacheData = await cache.get(chunkName);

    // If there is a cache, return it
    if (cacheData) {
      return new Response(cacheData.body, { headers: cacheData.headers });
    }

    const res = await ctx.next();
    if (!res.ok) { // Only cache if 200 OK
      return res;
    }

    // get raw asset content
    const data = await res.arrayBuffer();
    // cache data
    cache.set(chunkName, data, Object.fromEntries(res.headers.entries()));

    return new Response(data, {
      headers: res.headers,
      status: res.status,
      statusText: res.statusText,
    });
  },
];

// Handling Kv Cache

// key                                                        | value
// ["__fresh_cache__", "buildId"]                             | BUILD_ID
// ["__fresh_cache__", "headers", BUILD_ID, chunkName]        | { key: value, ... } // headers data
// ["__fresh_cache__", "buildOutput", BUILD_ID, chunkName, i] | ArrayBuffer {} // split content

const maxArrayBufferLength = 60000; // less than 65536
const KV_PREFIX = "__fresh_cache__";
class CacheData {
  #inMemoryCache: Record<
    string,
    { headers: Record<string, string>; body: ArrayBuffer } | undefined
  > = {};
  // avoid tla
  #kvInitPromise = this.#initKv();

  /** initialize KV */
  async #initKv() {
    console.time("init kv");

    const kv = await Deno.openKv(DEBUG ? "./cache.sqlite" : undefined);
    const buildIdInKv = (await kv.get<string>([KV_PREFIX, "buildId"])).value;
    if (buildIdInKv === BUILD_ID) {
      await this.#loadAllCache(kv);
      console.timeEnd("init kv");
      return kv;
    }
    if (buildIdInKv) {
      // clean cache
      const prefix = [KV_PREFIX];
      // TODO: delete in parallel
      const kvDeletePromise = [];
      for await (const entry of kv.list<ArrayBuffer>({ prefix })) {
        kvDeletePromise.push(kv.delete(entry.key));
      }
      await Promise.all(kvDeletePromise);
    }
    await kv.set([KV_PREFIX, "buildId"], BUILD_ID);
    console.timeEnd("init kv");
    return kv;
  }

  async #loadAllCache(kv: Deno.Kv) {
    // get all cache data from KV

    // get contents data from KV
    const cacheData: Record<string, ArrayBuffer[]> = {};
    const cacheList = kv.list<ArrayBuffer>({
      prefix: [KV_PREFIX, "buildOutput", BUILD_ID],
    });
    for await (const entry of cacheList) {
      const [_, __, ___, chunkName] = entry.key;
      (cacheData[chunkName as string] ??= []).push(entry.value);
    }

    // get headers data from KV
    const headersData: Record<string, Record<string, string>> = {};
    const headersList = kv.list<Record<string, string>>({
      prefix: [KV_PREFIX, "headers", BUILD_ID],
    });
    for await (const entry of headersList) {
      const [_, __, ___, chunkName] = entry.key;
      headersData[chunkName as string] = entry.value;
    }

    // set to in-memory cache
    for (const [chunkName, buffers] of Object.entries(cacheData)) {
      this.#inMemoryCache[chunkName] = {
        body: await concatArrayBuffers(buffers),
        headers: headersData[chunkName],
      };
    }
  }

  async get(chunkName: string) {
    await this.#kvInitPromise;

    // get from in-memory cache
    if (this.#inMemoryCache[chunkName]) {
      return this.#inMemoryCache[chunkName];
    }

    console.log("request build cache:", BUILD_ID, chunkName);

    return this.#inMemoryCache[chunkName];
  }

  async set(
    chunkName: string,
    content: ArrayBuffer,
    headers: Record<string, string>,
  ) {
    // set to in-memory cache
    this.#inMemoryCache[chunkName] = { body: content, headers };

    const kv = await this.#kvInitPromise;
    const buffers = splitArrayBuffer(content, maxArrayBufferLength);

    console.log("set build cache:", BUILD_ID, chunkName, buffers);

    // add headers data and contents to KV
    while (true) {
      let atomic = kv.atomic()
        .set([KV_PREFIX, "headers", BUILD_ID, chunkName], headers);
      if (buffers.length === 0) {
        atomic = atomic.set(
          [KV_PREFIX, "buildOutput", BUILD_ID, chunkName, 0],
          new ArrayBuffer(0),
        );
      } else {
        for (const [i, buffer] of buffers.entries()) {
          atomic = atomic.set(
            [KV_PREFIX, "buildOutput", BUILD_ID, chunkName, i],
            buffer,
          );
        }
      }
      const res = await atomic.commit();
      if (res.ok) {
        break;
      }
    }
  }
}
const cache = new CacheData();

/** split the {buffer} so that the length fits within {maxArrayBufferLength} */
function splitArrayBuffer(buffer: ArrayBuffer, maxArrayBufferLength: number) {
  const buffers = [];
  for (let i = 0; i < buffer.byteLength; i += maxArrayBufferLength) {
    buffers.push(buffer.slice(i, i + maxArrayBufferLength));
  }
  return buffers;
}

async function concatArrayBuffers(buffers: ArrayBuffer[]) {
  const blob = new Blob(buffers);
  return await blob.arrayBuffer();
}