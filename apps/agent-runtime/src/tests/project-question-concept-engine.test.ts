import assert from "node:assert/strict";
import test from "node:test";
import { inferTargetConcept } from "../runtime/ProjectQuestionConceptEngine.js";

test("tech stack inventory is structural rather than a specific target concept", () => {
  const result = inferTargetConcept({
    question: "tell me the full tech stack",
    topicPhrase: "tech stack",
    topicTerms: ["tech", "stack"],
    entities: []
  });

  assert.equal(result, "general");
});
