#!/usr/bin/env node
// cards402 CLI dispatcher.
//
// Subcommands:
//   onboard    Trade a one-time claim code for an api key + create an
//              OWS wallet. The agent-facing setup path (see skill.md).
//   mcp        Start the MCP server over stdio (default when no
//              subcommand is given, so `npx cards402` in an MCP
//              client's config "just works").
//   version    Print the installed SDK version and exit.
//
// Each subcommand lives in its own module and is imported dynamically
// so `cards402 onboard` doesn't pay the cost of loading the MCP server
// handlers (~500 lines of tool registration) and vice versa.

async function main(): Promise<number> {
  const [, , cmd = 'mcp', ...rest] = process.argv;

  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(`cards402 — virtual Visa cards for AI agents

Usage:
  cards402 onboard --claim <code>    Set up an agent from a dashboard claim code
  cards402 mcp                       Start the MCP server over stdio (default)
  cards402 version                   Print the SDK version
  cards402 --help                    Show this message

Docs: https://cards402.com/docs
Onboarding guide for agents: https://cards402.com/skill.md
`);
    return 0;
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../package.json') as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  if (cmd === 'onboard') {
    const { onboardCommand } = await import('./commands/onboard');
    return onboardCommand(rest);
  }

  if (cmd === 'mcp') {
    const { startMcpServer } = await import('./mcp');
    await startMcpServer();
    return 0;
  }

  process.stderr.write(`error: unknown command '${cmd}'\n`);
  process.stderr.write(`Run 'cards402 --help' to see available commands.\n`);
  return 2;
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);
