import { NextResponse } from "next/server";
import { createIntent } from "@/lib/store";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const amountSol = Number(body.amountSol);
    const amountLamports = Math.round(amountSol * 1_000_000_000);
    return NextResponse.json({ intent: createIntent(body.merchantBadgeId, amountLamports) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }
}