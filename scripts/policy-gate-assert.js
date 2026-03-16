#!/usr/bin/env node
"use strict";

require("dotenv").config();
const { evaluateTaskPolicyWithExternal } = require("../control/policy-engine");

async function main() {
  const originalReadOnly = process.env.POLICY_READ_ONLY_MODE;
  try {
    process.env.POLICY_READ_ONLY_MODE = "true";

    const simulatedAiMutation = {
      id: "policy-assert-ai-mutation",
      type: "send_email",
      payload: {
        to: process.env.POLICY_TEST_EMAIL || "test@localhost",
        subject: "AI drafted",
        body: "draft",
        ai_suggested: true,
      },
    };

    const verdict = await evaluateTaskPolicyWithExternal(simulatedAiMutation);
    if (verdict.allowed) {
      throw new Error("policy gate violation: mutating AI suggestion was allowed in read-only mode");
    }

    // Non-mutating task should remain allowed so we don't over-block pipeline.
    const nonMutating = await evaluateTaskPolicyWithExternal({
      id: "policy-assert-safe",
      type: "report",
      payload: { scope: "daily" },
    });

    if (!nonMutating.allowed) {
      throw new Error(`policy over-blocking: expected report to be allowed, reason=${nonMutating.reason}`);
    }

    console.log("[policy-gate-assert] PASS");
    console.log(JSON.stringify({
      blocked_mutation_reason: verdict.reason,
      allowed_non_mutating: nonMutating.allowed,
      engine: verdict.engine,
    }, null, 2));
  } finally {
    if (originalReadOnly == null) delete process.env.POLICY_READ_ONLY_MODE;
    else process.env.POLICY_READ_ONLY_MODE = originalReadOnly;
  }
}

main().catch((err) => {
  console.error(`[policy-gate-assert] FAIL: ${err.message}`);
  process.exit(1);
});
