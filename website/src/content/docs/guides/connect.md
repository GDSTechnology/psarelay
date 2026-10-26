---
title: Connect your AI
description: Add PSArelay to ChatGPT, Claude, Codex or n8n — sign in with your console login, no command line on the server.
---

Every person connects their own AI client and signs in as themselves. PSArelay then works as **their Autotask
user**: Autotask applies their own permissions to every change, and the console records who did what.

## Before you start (administrator, once)

- **The server's public address**: set `MCP_PUBLIC_URL` to the **https** address the AI clients reach (for example
  `https://mcp.example.com`). Hosted PSArelay has this already.
- **Link people to their Autotask user**: console → **Users** → *Autotask user* → **Link** (their Autotask email).
  Someone who is not linked can't sign in from an AI client.
- **Choose which AI clients may connect**: console → **Settings → Security → AI clients allowed to connect**.
  Nothing is forced on you: untick ChatGPT, Claude, Copilot, Grok or any other client and it can't sign in (its
  existing connections end within an hour). People only see the clients you allow on their Connect page.

## ChatGPT

1. ChatGPT → **Settings → Connectors → Create**.
2. Name **PSArelay**, the address from console → **Connect**, Authentication **OAuth**.
3. **Connect** — a PSArelay sign-in page opens. Sign in with your console login.

Business and Enterprise workspaces: an admin adds it once and shares it; each person still signs in as themselves.

## Claude (claude.ai, Desktop)

1. **Settings → Connectors → Add custom connector**, paste the address.
2. **Connect** and sign in with your console login.

## Microsoft 365 Copilot

An administrator builds a small Copilot agent once and shares it with staff. Nothing is installed on the server.

1. In VS Code, install the [Microsoft 365 Agents Toolkit](https://aka.ms/M365AgentsToolkit) (6.12 or later).
2. **Create a New Agent/App → Declarative Agent → Add an Action → Start with an MCP Server**, paste the address
   from console → **Connect**.
3. Authentication: **OAuth (with dynamic registration)**. PSArelay registers Copilot and issues it a client secret,
   which Microsoft requires.
4. Name it **PSArelay**, then **Provision**. In [Copilot](https://m365.cloud.microsoft/chat) → **Agents** →
   *PSArelay* → **Sign in** with your console login.
5. To roll it out: **Publish**, approve it in the **Teams admin center → Manage apps**, and assign it to the staff
   who should have it. Each person signs in as themselves.

Free Copilot Chat seats ("Microsoft 365 Copilot (Basic)") may need **pay-as-you-go** billing turned on in the
Microsoft 365 admin center before they can use agents that call actions. Try it with one person first.

## Codex

```bash
codex mcp add psarelay --url https://mcp.example.com/mcp
```

```bash
codex mcp login psarelay
```

## n8n and scripts

They can't sign in interactively. Create a token on your **Account** page (or an administrator creates a service
token on **Access**) and send it as `Authorization: Bearer <token>`.

## How the sign-in works

PSArelay is its own OAuth 2.1 authorization server, as the MCP specification describes: clients find it from
`/.well-known/oauth-protected-resource`, register themselves, and sign the person in with PKCE. ChatGPT, Claude and
Codex register as public clients; Microsoft 365 Copilot registers as a confidential client and gets a client secret
(only its hash is stored). Access tokens last an
hour and work only on this server; refresh tokens rotate, and a reused one disconnects that client at once.
Disconnect any client from console → **Connect** → *Signed in as you*.
