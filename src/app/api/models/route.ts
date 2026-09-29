/**
 * The models this machine can actually use, right now.
 *
 * Deliberately a live query rather than a configured list. The set of free
 * models rotates - providers add and retire them without notice - so any
 * hardcoded roster in the README or the code is wrong within weeks. The panel
 * shows what was discovered so the choice is visible rather than implicit.
 */

import { NextResponse } from "next/server";
import { getProvider } from "@/lib/ai";
import { checkHealth, listFreeModels } from "@/lib/ai/models";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    const provider = getProvider();
    const catalogue = await listFreeModels(provider);
    const health = await checkHealth(provider, { probe: false });
    return NextResponse.json({
      provider: provider.name,
      discovered: catalogue.total,
      free: catalogue.free.length,
      rejected: catalogue.rejected,
      primary: catalogue.primary ?? null,
      discoveredAt: catalogue.discoveredAt,
      pricingAvailable: catalogue.pricingAvailable,
      health,
      models: catalogue.free.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        verifiablyFree: m.verifiablyFree,
        contextWindow: m.contextWindow ?? null,
        supportsImages: !!m.supportsImages,
      })),
    });
  } catch (error) {
    // Reported rather than thrown: the panel stays usable without the model
    // list, and a failure here is itself useful information.
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
