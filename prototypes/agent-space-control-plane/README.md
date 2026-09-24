# T-536 Agent Space Local Prototype

This directory is an isolated, read-only prototype for owner review. It is not a Portal route, does not import runtime services, and does not read a production database, Workspace, resolver setting, or user asset bytes.

## Start

```bash
node prototypes/agent-space-control-plane/verify.mjs
node prototypes/agent-space-control-plane/server.mjs
```

Open `http://127.0.0.1:4178`. Set `PORT` to use another local port.

## Data Source Map

| Prototype field | Authoritative runtime concept | Sanitized replay source |
| --- | --- | --- |
| Agent and status | `agent_space_agents` | T-530 B-side assembly evidence |
| Method/version/status | method binding and method version | T-530 D1-D7 decision evidence |
| Skill installation | Agent installation manifest | T-530 B-side explicit empty Skill set |
| Task dependency | task dependency snapshot | T-530 daily-review dependency replay |
| Run basis | `agent_space_run_basis` resolution/injection | T-530 run evidence |
| Execution/delivery | automation run outcome and push-job terminal state | T-530 success and failure replay cases |

`fixture.json` replaces real scope identifiers and all user-authored content with `scope-demo`, generic object labels, abbreviated checksums, and derived status facts. It contains no database path, token, Workspace content, conversation content, asset body, phone number, or message payload.

## Owner Review Checklist

- The distinction among adopted, owner-review, excluded, and explicit-empty states is understandable.
- A selected run makes its actual method, asset role/version, state packet, injection, execution, and delivery facts inspectable.
- Empty Skill installation and empty task dependency are visibly different conditions.
- No UI element suggests a write, approval, installation, scheduler, or deletion capability.
- The scope label and read-only boundary are prominent enough for a future Portal design.

## Release Boundary

Passing this prototype only supports an owner information-architecture review. A later Portal task must separately introduce authenticated, scope-enforced read APIs, server-side redaction, object/version consistency checks, browser acceptance, and release review. It must not reuse this fixture as a production data source.
