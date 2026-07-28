import assert from "node:assert/strict";
import test from "node:test";

import { classifyQuestionSet, type CreationMethodAnalysisInput } from "../worker/questionSetCreationMethodAnalyzer";

function input(overrides: Partial<CreationMethodAnalysisInput> = {}): CreationMethodAnalysisInput {
  return {
    id: "set-1",
    title: "Set",
    createdAt: "2026-07-01T00:00:00.000Z",
    imageCount: 1,
    questions: [{
      image_url: "https://assets.example.com/question-images/2026/07/01/a.webp",
      label_text: null,
      label_source: null,
      label_updated_at: null,
    }],
    r2Samples: [],
    ...overrides,
  };
}

test("R2 URL-import metadata takes precedence and local-upload metadata identifies manual creation", () => {
  const assisted = classifyQuestionSet(input({
    r2Samples: [{ key: "question-images/2026/07/01/a.webp", found: true, importSource: "url-text" }],
  }));
  assert.equal(assisted.creationMethod, "creation_tool_assisted");
  assert.equal(assisted.basis, "r2_url_import_metadata");

  const manual = classifyQuestionSet(input({
    r2Samples: [{ key: "question-images/2026/07/01/a.webp", found: true, importSource: null }],
  }));
  assert.equal(manual.creationMethod, "player_manual");
  assert.equal(manual.basis, "r2_local_upload_metadata");
});

test("external URLs follow the URL-import default and ambiguous legacy evidence remains unresolved", () => {
  const external = classifyQuestionSet(input({
    questions: [{ image_url: "https://example.com/a.jpg", label_text: null, label_source: null, label_updated_at: null }],
  }));
  assert.equal(external.creationMethod, "creation_tool_assisted");
  assert.equal(external.basis, "external_url");

  const legacyCloudinary = classifyQuestionSet(input({
    questions: [{
      image_url: "https://res.cloudinary.com/demo/image/upload/anime-master-game/a.webp",
      label_text: null,
      label_source: null,
      label_updated_at: null,
    }],
  }));
  assert.equal(legacyCloudinary.creationMethod, null);
  assert.equal(legacyCloudinary.basis, "legacy_managed_external_url");

  const unresolved = classifyQuestionSet(input());
  assert.equal(unresolved.creationMethod, null);
  assert.equal(unresolved.basis, "insufficient_evidence");
});

test("known tool image URLs plus creation-time labels are high-confidence tool evidence", () => {
  const result = classifyQuestionSet(input({
    questions: [{
      image_url: "https://cdni.fancaps.net/file/fancaps-animeimages/123.jpg",
      label_text: "Answer",
      label_source: "manual",
      label_updated_at: "2026-07-01T00:01:00.000Z",
    }],
  }));
  assert.equal(result.creationMethod, "creation_tool_assisted");
  assert.equal(result.basis, "known_tool_url_with_initial_labels");
  assert.equal(result.confidence, "high");
});

test("creation-time labels recover older tool imports when R2 metadata is unavailable", () => {
  const result = classifyQuestionSet(input({
    questions: [{
      image_url: "https://assets.example.com/question-images/legacy/a.webp",
      label_text: "Answer",
      label_source: "manual",
      label_updated_at: "2026-07-01T00:01:00.000Z",
    }],
  }));
  assert.equal(result.creationMethod, "creation_tool_assisted");
  assert.equal(result.basis, "initial_labels");
  assert.equal(result.confidence, "medium");
});
