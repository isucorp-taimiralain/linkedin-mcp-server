#!/usr/bin/env node

import { getAutomationConfigPath, prepareAutoPost, runAutoPostJob } from "./autopost.js";

interface CliFlags {
  dryRun: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

async function runDryMode(): Promise<void> {
  const prepared = await prepareAutoPost();

  console.log("Auto-post dry run completed.\n");
  console.log(`Niche   : ${prepared.config.niche}`);
  console.log(`Keyword : ${prepared.candidate.keyword}`);
  console.log(`Source  : ${prepared.candidate.source || "Unknown"}`);
  console.log(`Article : ${prepared.candidate.title}`);
  console.log(`Link    : ${prepared.candidate.link}`);
  console.log(`\nImage search query (Unsplash, based on article title):\n`);
  console.log(`  "${prepared.imageSearchQuery}"`);
  console.log(`\nGenerated post commentary:\n`);
  console.log(prepared.commentary);
}

async function main() {
  const { dryRun } = parseFlags(process.argv.slice(2));

  console.log("LinkedIn MCP Server - Auto Posting");
  console.log("===================================\n");
  console.log(`Config path: ${getAutomationConfigPath()}\n`);

  try {
    if (dryRun) {
      await runDryMode();
      process.exit(0);
    }

    const result = await runAutoPostJob();
    console.log("Auto post created successfully.\n");
    console.log(`Post ID: ${result.postId}`);
    console.log(`Keyword used: ${result.keyword}`);
    console.log(`Source: ${result.source}`);
    console.log(`Article: ${result.articleTitle}`);
    console.log(`Link: ${result.articleLink}`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Auto posting failed: ${message}`);
    process.exit(1);
  }
}

main();
