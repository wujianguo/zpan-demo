export function getModel(): string {
  return  required("ANTHROPIC_MODEL") || "claude-opus-4-6";
}

export function getAgentEnv(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: required("ANTHROPIC_BASE_URL"),
    ANTHROPIC_AUTH_TOKEN: required("ANTHROPIC_AUTH_TOKEN"),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}
