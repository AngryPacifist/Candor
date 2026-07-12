import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  txline: {
    origin: required("TXLINE_API_ORIGIN"),
    apiToken: required("TXLINE_API_TOKEN"),
    // Bootstrap JWT; the client re-issues via /auth/guest/start when stale.
    jwt: process.env.TXLINE_JWT ?? null,
  },
  solana: {
    rpcUrl: required("SOLANA_RPC_URL"),
    devnetRpcUrl: process.env.SOLANA_DEVNET_RPC_URL ?? "https://api.devnet.solana.com",
    keypairPath: process.env.AGENT_KEYPAIR_PATH ?? ".secrets/agent-keypair.json",
    programId: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
    memoProgramId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  },
  databaseUrl: required("DATABASE_URL"),
  publicUrl: process.env.PUBLIC_URL ?? null,
} as const;
