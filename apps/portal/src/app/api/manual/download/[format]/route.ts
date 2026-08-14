import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { buildManualMarkdown } from "@/content/user-manual";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: { format: string } }
) {
  if (params.format === "md") {
    return new NextResponse(buildManualMarkdown(), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": 'attachment; filename="invest-agent-user-manual.md"'
      }
    });
  }

  if (params.format === "pdf") {
    const pdf = await readFile(
      join(process.cwd(), "public", "manual", "invest-agent-user-manual.pdf")
    );
    return new NextResponse(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="invest-agent-user-manual.pdf"'
      }
    });
  }

  return NextResponse.json({ error: "unsupported format" }, { status: 404 });
}
