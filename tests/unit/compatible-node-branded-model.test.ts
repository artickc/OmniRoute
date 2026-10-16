import test from "node:test";
import assert from "node:assert/strict";
import { resolveCompatibleNodeModel } from "../../src/sse/services/model.ts";

const branded = [{ id: "euromodels/claude-fable-5" }, { id: "euromodels/gpt-5.6-sol" }];
const bare = [{ id: "glm-5.2" }, { id: "qwen3" }];

test("branded catalog restores prefix after parseModel split", () => {
  assert.equal(
    resolveCompatibleNodeModel("claude-fable-5", "euromodels", [], branded),
    "euromodels/claude-fable-5"
  );
});

test("branded catalog keeps already-branded remainder (nodeId path)", () => {
  assert.equal(
    resolveCompatibleNodeModel("euromodels/claude-fable-5", "euromodels", [], branded),
    "euromodels/claude-fable-5"
  );
});

test("branded catalog peels a dummy prefix segment down to the catalog id", () => {
  assert.equal(
    resolveCompatibleNodeModel("euromodels/euromodels/claude-fable-5", "euromodels", [], branded),
    "euromodels/claude-fable-5"
  );
});

test("unbranded catalog still strips combo nodeId/prefix/model", () => {
  assert.equal(resolveCompatibleNodeModel("pix4k/glm-5.2", "pix4k", [], bare), "glm-5.2");
  assert.equal(resolveCompatibleNodeModel("glm-5.2", "pix4k", [], bare), "glm-5.2");
});
