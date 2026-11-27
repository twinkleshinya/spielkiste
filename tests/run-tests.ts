import {testStyleConflictApiResponse,testStyleConflictNeedsUserClarification,testStyleConflictBrowserClarification,testReferenceStyleResearchAndPropagation,testReferenceStyleReanalysisInput,testReferenceStyleTitleResolution,testReferenceStyleKeywordUi} from "./sfx-reference-style.test.js";
import {testKeywordRanking,testKeywordPlannerScope,testKeywordPersistence,testGeminiReceivesKeywordPreference} from "./sfx-keyword-preferences.test.js";
import {testLibraryExclusionsSearchAndPlanner,testExclusionsCandidateAndGeminiBoundaries,testExclusionsPersistenceAndManualSelection,testExclusionsHttpRoutes} from "./sfx-library-exclusions.test.js";
import {testSfxExclusionsStageRestoreAndGuard,testSfxSeparatedGroupsAndBulkMute,testFailedGenerationShowsCauseAndAllowsRetry} from "./sfx-edit-preview-ui.test.js";
import assert from "node:assert/strict";
import {testCreativeContextNeverSerializesProject,testTaskPauseResumeAndTerminate,testTaskControlUi} from './sfx-task-control.test.js';
testCreativeContextNeverSerializesProject();await testTaskPauseResumeAndTerminate();await testTaskControlUi();
import {testBlankProjectNameUsesVideoFilename} from "./sfx-project-name.test.js";
await testBlankProjectNameUsesVideoFilename();
import {testAnalysisCanProgressPastThirtyMinutes,testAnalysisFailureIncludesLastStage,testReadyStatusWaitsForFinalSave,testDescribedAndReidentifyJobsHaveNoTotalDeadline} from "./sfx-analysis-lifetime.test.js";
await testAnalysisCanProgressPastThirtyMinutes();await testAnalysisFailureIncludesLastStage();await testDescribedAndReidentifyJobsHaveNoTotalDeadline();await testReadyStatusWaitsForFinalSave();
import { testDirectorMusicSchema, testDirectorSemanticSafety, testMusicCandidatesRequireIndependentLibrary, testDirectorContinuousPlacements, testDirectorTemporalMerging, testDirectorWorkflow } from "./sfx-director.test.js";
import { testSfxLibrary, testSfxLazyLibrary, testLibraryScanBoundedConcurrency, testSfxAnalysis, testSfxRendering, testSfxApi } from "./sfx-tests.js";
import { testSfxImportPaths } from "./sfx-import.test.js";
import { testSfxMultilayer, testSfxAutoModeSchema, testSfxActionCoverageAndSemanticMatching } from "./sfx-tests.js";
import { AudioReferenceAnalysisAgent } from "../src/agents/AudioReferenceAnalysisAgent.js";
import { AssetNamingAgent } from "../src/agents/AssetNamingAgent.js";
import { buildSkillSheetRowsForTest, parseSheetIdsFromSheetInfoOutput, parseSkillItemsFromSheetOutput } from "../src/agents/FeishuDocumentAgent.js";
import { markdownToBlocks } from "../src/renderers/MarkdownRenderer.js";
import { AudioDesignPlan, ReferencePack } from "../src/schemas/index.js";
import { testSfxComparison } from "./sfx-comparison.test.js";
import { testFilenameStageConstraints, testNaturalOneShotTails, testAutoMixHierarchy, testOrdinaryFootstepsStaySecondary, testAutoMixFork, testSelectiveAudioPolicy, testGeminiTimingRequired, testCharacterVocalPriority, testBossLayerBudgetAndDenseChain, testWorkflowDensityReview } from "./sfx-stage-mix.test.js";
import { testDistanceMixHierarchy, testDistanceAnalysisAndPersistence, testDistanceRenderedHeadroom, testDistanceEditPersistence } from "./sfx-distance-mix.test.js";
import { testGenerationHttpKeepsCallerCancellation, testSfxUsageIsolation } from "./sfx-usage.test.js";
import { testSoundAwareSourceLengths, testCroppedEdgeFades, testMeaningfulFilenameAlternatives, testMeasuredCandidateSimilarity } from "./sfx-editing.test.js";
import { testGeminiSourceEditBoundaries } from "./sfx-source-review.test.js";
import {testStandardWorkflowDefaults,testAudioOutputModes,testWorkflowExportEvidence,testWorkflowForkProvenance,testWorkflowApiResources,testAiConfigCore} from "./sfx-workflow.test.js";
import {testPreservedVersionReuse,testRemixPreservesSourceRanges,testSavedPreviewRetainsMix} from "./sfx-preservation.test.js";
import {testPreservedEditCreatesChild,testPreservedNoOpAndReadOnlySearch,testRetainedFadesSurviveMix,testSelectionReceivesSoundIntent,testOlderAcceptedVersionStaysProtected} from "./sfx-workflow-corrections.test.js";
import {testQuickEditApi} from "./sfx-quick-edit.test.js";
import {testLibraryPathRanking,testLibraryPreferencePersistence,testGeminiReceivesLibraryPreference,testLocalFolderBrowserApi,testLibraryPreferenceIndexAndFork} from "./sfx-library-preferences.test.js";
import {testSavedProjectRecovery,testProjectSummaryMigration,testClientRunPayloadOmitsUnreferencedLibraryAssets} from "./sfx-project-recovery.test.js";
import {testSfxStartupDefaultsToNewProject} from "./sfx-startup-ui.test.js";
import {testApplyEventTimingPreservesPlacementSettings,testLocateEventApiPreservesParentAndUsesOnlyTiming,testLocateEventLowConfidenceKeepsReviewFlag} from "./sfx-event-reidentify.test.js";
import {testAddDescribedEventApiLocatesAndPreservesExistingTimeline,testAddDescribedEventRejectsStaleRevision,testDescribedEventMixProtectsParentPlacements} from "./sfx-described-event.test.js";
import {testDescribedEventButtonFeedbackAndRecovery,testDescribedEventUiIsAnAddEventMode} from "./sfx-described-event-ui.test.js";
import {testSfxHealthCompatibilityMarker,testSfxHealthRouteAdvertisesCompatibility} from "./sfx-server-startup.test.js";
import {testSfxProjectVersioning} from "./sfx-project-versioning.test.js";
import {testReaperExporter,testReaperExportApi,testReaperExportUi,testReaperPortableProject,testReaperActionCategoryUsesEventIntent,testReaperNamesWithoutExtension} from "./sfx-reaper-export.test.js";
import {testSfxEditsWaitForExplicitPreviewUpdate,testSfxDraftRecoveryAndPreviewFailures,testReaperUiAcceptsNamesAndNeverRendersEdits,testSfxDraftCanBeDiscardedWithoutRendering,testCreativeBriefIsAuxiliaryAndSupportsExplicitReanalysis} from "./sfx-edit-preview-ui.test.js";
import {testReaperOriginalPackaging,testReaperPackagingFailure} from "./reaper-media.test.js";
import {testReaperNativePipeline} from "./reaper-native.test.js";

async function testAssetNamingAgent() {
  const plan: AudioDesignPlan = {
    summary: "test",
    openQuestions: [],
    items: [
      {
        assetId: "SFX Hero Skill Release 0",
        videoId: "video_01",
        timeRange: { startTime: 0, endTime: 1 },
        assetType: "sfx",
        designIntent: "release",
        soundDescription: "release",
        layerSuggestion: [],
        priority: "high",
        complexity: "medium",
        estimatedWorkload: "0.5d",
        deliveryFormat: "wav 48kHz/24bit",
        namingConvention: "SFX_{Character}_{Skill}_{Phase}_{Variation}_v001.wav",
        reviewCriteria: []
      }
    ]
  };
  const output = await new AssetNamingAgent().run(
    { projectName: "Project X", audioDesignPlan: plan },
    {
      runId: "test",
      runDir: ".output/test",
      projectName: "Project X",
      dryRun: true,
      fileAdapter: undefined as never,
      log: undefined as never
    }
  );
  assert.equal(output.rules.length, 3);
  assert.equal(output.normalizedTerms[0].normalized, "SFX_Hero_Skill_Release_0");
}

function testMarkdownToBlocks() {
  const blocks = markdownToBlocks("# Title\n\n## Section\n\n| A |\n|---|\n| B |");
  assert.deepEqual(blocks[0], { type: "heading1", text: "Title" });
  assert.deepEqual(blocks[1], { type: "heading2", text: "Section" });
  assert.equal(blocks[2].type, "table_markdown");
}

function testSkillSheetParsing() {
  const infoOutput = JSON.stringify({
    ok: true,
    data: {
      sheets: {
        sheets: [
          { sheet_id: "1c074a", title: "Sheet1" },
          { sheet_id: "UMIN2j", title: "Sheet2" }
        ]
      }
    }
  });
  assert.deepEqual(parseSheetIdsFromSheetInfoOutput(infoOutput), ["1c074a", "UMIN2j"]);

  const readOutput = JSON.stringify({
    ok: true,
    data: {
      valueRange: {
        values: [
          ["#血修神通（人）", null],
          [1000, "普通攻击"],
          [6001, "炼气-刀光"],
          [6002, "炼气-剑气"]
        ]
      }
    }
  });
  const simpleItems = parseSkillItemsFromSheetOutput(readOutput);
  assert.deepEqual(
    simpleItems.map((item) => [item.sourceId, item.skillName, item.phases[0].phaseType]),
    [
      ["1000", "普通攻击", "整体"],
      ["6001", "炼气-刀光", "整体"],
      ["6002", "炼气-剑气", "整体"]
    ]
  );

  const richReadOutput = JSON.stringify({
    ok: true,
    data: {
      valueRange: {
        values: [
          ["技能编号", "技能名称", "技能表现", "技能表现概述"],
          [
            "9001",
            "血斩",
            "cast:施法者对目标小范围从左向右横砍，特效颜色为红色+宝蓝色\ndamage1：微弱的血溅受击，颜色为红色+宝蓝色\nshield：血色护盾持续旋转",
            "短促近战技能，血色能量边缘带冷色"
          ]
        ]
      }
    }
  });
  const richItems = parseSkillItemsFromSheetOutput(richReadOutput);
  assert.equal(richItems.length, 1);
  assert.equal(richItems[0].skillName, "血斩");
  assert.deepEqual(richItems[0].phases.map((phase) => phase.phaseType), ["cast", "damage1", "shield"]);
  assert.match(richItems[0].phases[0].polishedDescription, /短促近战技能/);

  const flattened = buildSkillSheetRowsForTest([{ ...richItems[0], generatedId: "1" }]);
  assert.deepEqual(
    flattened.rows.map((row) => [row.generatedId, row.skillName, row.phaseType]),
    [
      ["1", "血斩", "cast"],
      ["1", "血斩", "damage1"],
      ["1", "血斩", "shield"]
    ]
  );
  assert.deepEqual(flattened.mergeRanges.map((range) => range.range), ["A9:A11", "B9:B11"]);
}

async function testAudioReferenceAnalysisAgentFallback() {
  const referencePack: ReferencePack = {
    projectSummary: "技能音效测试",
    worldBackground: "暗黑修仙",
    characterProfiles: [],
    factionOrElementSystem: [],
    emotionalTone: [],
    visualStyleKeywords: [],
    audioStyleKeywords: ["血", "能量"],
    competitorReferenceSummary: [],
    existingAudioRules: [],
    reusableTerminology: [],
    riskNotes: [],
    openQuestions: [],
    confidence: 0.6,
    sources: []
  };
  const output = await new AudioReferenceAnalysisAgent().run(
    {
      projectName: "M71",
      enabled: false,
      audioReferenceFiles: ["F:/refs/blood_skill.wav"],
      requirementText: "技能音效",
      styleText: "低频短冲，魔法颗粒",
      referencePack
    },
    {
      runId: "test",
      runDir: ".output/test",
      projectName: "M71",
      dryRun: true,
      fileAdapter: undefined as never,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined }
    }
  );
  assert.equal(output.enabled, false);
  assert.equal(output.analyzedFiles.length, 1);
  assert.match(output.keepList.join("\n"), /瞬态|材质/);
}

const audioSelectionTests = await import("./sfx-audio-selection.test.js");
for(const test of Object.values(await import("./sfx-candidate-resilience.test.js")))await test();
audioSelectionTests.testChargeCandidateStages();
await audioSelectionTests.testGeminiNameAdviceOverride();
await audioSelectionTests.testSelectionKeepsCompatibleBaseline();
await audioSelectionTests.testUiSweepRejection();
await audioSelectionTests.testGeminiAudioSelection();
await audioSelectionTests.testGeminiAudioSelectionBoundaries();
await audioSelectionTests.testGeminiRejectKeepsBestVisibleActionCandidate();
await audioSelectionTests.testGeminiAudioReselectRun();
await audioSelectionTests.testGeminiAudioDistinctLayers();
await audioSelectionTests.testGeminiCandidateOnset();
testDirectorMusicSchema();
testDirectorSemanticSafety();
testMusicCandidatesRequireIndependentLibrary();
testDirectorContinuousPlacements();
testDirectorTemporalMerging();
await testDirectorWorkflow();
await testAssetNamingAgent();
testMarkdownToBlocks();
testSkillSheetParsing();
await testAudioReferenceAnalysisAgentFallback();
await testSfxLibrary();
await testSfxLazyLibrary();
await testFailedGenerationShowsCauseAndAllowsRetry();
await testLibraryScanBoundedConcurrency();
await testSfxAnalysis();
await testSfxRendering();
await testSfxApi();
testSfxImportPaths();
testSfxMultilayer();
testSfxAutoModeSchema();
testSfxActionCoverageAndSemanticMatching();
testSfxComparison();
testFilenameStageConstraints();
testNaturalOneShotTails();
testAutoMixHierarchy();
testOrdinaryFootstepsStaySecondary();
testDistanceMixHierarchy();
await testDistanceAnalysisAndPersistence();
await testDistanceEditPersistence();
await testDistanceRenderedHeadroom();
testCharacterVocalPriority();
testBossLayerBudgetAndDenseChain();
testWorkflowDensityReview();
await testAutoMixFork();
await testSfxUsageIsolation();await testGenerationHttpKeepsCallerCancellation();
testSelectiveAudioPolicy();
await testGeminiTimingRequired();
testSoundAwareSourceLengths();
testCroppedEdgeFades();
testMeaningfulFilenameAlternatives();
await testMeasuredCandidateSimilarity();
await testGeminiSourceEditBoundaries();
await testStandardWorkflowDefaults();
await testWorkflowExportEvidence();
await testWorkflowForkProvenance();
await testWorkflowApiResources();
await testAiConfigCore();
await testPreservedVersionReuse();
await testRemixPreservesSourceRanges();
await testSavedPreviewRetainsMix();
await testPreservedEditCreatesChild();
await testPreservedNoOpAndReadOnlySearch();
await testRetainedFadesSurviveMix();
await testSelectionReceivesSoundIntent();
await testOlderAcceptedVersionStaysProtected();
await testQuickEditApi();
testKeywordRanking();
testLibraryExclusionsSearchAndPlanner();
await testExclusionsCandidateAndGeminiBoundaries();
await testExclusionsPersistenceAndManualSelection();
await testExclusionsHttpRoutes();
await testSfxExclusionsStageRestoreAndGuard();
testKeywordPlannerScope();
await testKeywordPersistence();
await testGeminiReceivesKeywordPreference();
testLibraryPathRanking();
await testLibraryPreferencePersistence();
await testGeminiReceivesLibraryPreference();
await testLocalFolderBrowserApi();
await testLibraryPreferenceIndexAndFork();
await testSavedProjectRecovery();
await testProjectSummaryMigration();
await testClientRunPayloadOmitsUnreferencedLibraryAssets();
await testSfxStartupDefaultsToNewProject();
testApplyEventTimingPreservesPlacementSettings();
await testLocateEventApiPreservesParentAndUsesOnlyTiming();
testLocateEventLowConfidenceKeepsReviewFlag();
await testAddDescribedEventApiLocatesAndPreservesExistingTimeline();
await testAddDescribedEventApiLocatesAndPreservesExistingTimeline(false, "scoped");
await testAddDescribedEventApiLocatesAndPreservesExistingTimeline(false, "missing");
await testAddDescribedEventApiLocatesAndPreservesExistingTimeline(false, "filtered");
await testAddDescribedEventRejectsStaleRevision();
testDescribedEventMixProtectsParentPlacements();
await testDescribedEventUiIsAnAddEventMode();await testDescribedEventButtonFeedbackAndRecovery();
testSfxHealthCompatibilityMarker();
await testSfxHealthRouteAdvertisesCompatibility();
await testSfxProjectVersioning();
await testReaperExporter();
await testReaperExportApi();
await testReaperExportUi();
await testReaperNamesWithoutExtension();
await testSfxEditsWaitForExplicitPreviewUpdate();
await testSfxSeparatedGroupsAndBulkMute();
await testSfxDraftRecoveryAndPreviewFailures();
await testReaperUiAcceptsNamesAndNeverRendersEdits();
await testSfxDraftCanBeDiscardedWithoutRendering();
await testCreativeBriefIsAuxiliaryAndSupportsExplicitReanalysis();
await testReaperPortableProject();
await testReaperActionCategoryUsesEventIntent();
await testReaperOriginalPackaging();
await testReaperPackagingFailure();
await testReaperNativePipeline();
console.log("59 test groups passed");
import { testWindowsFfmpegInvocationUsesBinaryDirectly, testWindowsFfmpegPermissionFallbacks } from "./ffmpeg-binaries.test.js";
await testWindowsFfmpegInvocationUsesBinaryDirectly();
await testWindowsFfmpegPermissionFallbacks();

import { testDesktopRuntimeResources, testDesktopAllowsMultipleInstancesAndIndependentPanels } from "./desktop-runtime.test.js";
import { testNativeFolderSelection, testWindowsFolderRootsMergeMappedAndNetworkPaths, testNetworkShareRootsParseNetUseOutput, testBrowserFolderSelectionExplainsSystemPathLimit, testFolderPickerReportsHelperExit } from "./sfx-native-folders.test.js";
testWindowsFolderRootsMergeMappedAndNetworkPaths();
testNetworkShareRootsParseNetUseOutput();
await testNativeFolderSelection();
await testBrowserFolderSelectionExplainsSystemPathLimit();
await testFolderPickerReportsHelperExit();
import { testProjectGit } from "./project-git.test.js";
import { testToolCodeGit } from "./tool-git.test.js";
import { testWebStartupUsesSharedGitWatcher } from "./sfx-web-git-startup.test.js";
await testDesktopRuntimeResources();
await testDesktopAllowsMultipleInstancesAndIndependentPanels();
await testProjectGit();
await testToolCodeGit();
await testWebStartupUsesSharedGitWatcher();
console.log("All regression groups including desktop and Git passed");
import {testCreativeBriefPersistence,testReanalysisUsesNewBriefAndPreservesParent} from './sfx-creative-brief.test.js';
import {testFolderKeywordSearch} from './sfx-folder-search.test.js';
import {testStyleResearchCacheAndEvidence} from './sfx-style-research.test.js';
import {testGenerateRequiresExplicitClick} from './sfx-edit-preview-ui.test.js';
await testCreativeBriefPersistence();await testReanalysisUsesNewBriefAndPreservesParent();await testFolderKeywordSearch();await testStyleResearchCacheAndEvidence();await testGenerateRequiresExplicitClick();
await testReferenceStyleResearchAndPropagation();await testReferenceStyleReanalysisInput();
await testReferenceStyleTitleResolution();await testReferenceStyleKeywordUi();
console.log('Style, creative brief, path search and explicit generation passed');

await testStyleConflictNeedsUserClarification();await testStyleConflictBrowserClarification();
await testStyleConflictApiResponse();

import {testLibraryScanHasNoDeadline,testGenerationDeadlineExcludesLibraryScan,testLibraryCacheReuseAndRefresh,testLibraryCacheLegacyCorruptAndConcurrent,testLibraryCacheCancellationIsolation,testLibraryCacheRealFileChanges,testGenerationReusesAllLibraryIndexes,testLibraryIndexRefreshApi,testLibraryIndexRefreshUi} from "./sfx-library-cache.test.js";
await testLibraryScanHasNoDeadline();await testGenerationDeadlineExcludesLibraryScan();
await testLibraryCacheReuseAndRefresh();await testLibraryCacheLegacyCorruptAndConcurrent();await testLibraryCacheCancellationIsolation();await testLibraryCacheRealFileChanges();await testGenerationReusesAllLibraryIndexes();await testLibraryIndexRefreshApi();await testLibraryIndexRefreshUi();

import {testDescriptionConstraints} from './sfx-description-constraints.test.js';
await testDescriptionConstraints();
console.log('Description constraint checks passed');

const recoveryTests=await import("./sfx-retrieval-recovery.test.js");
await recoveryTests.testVocalIntentRetrieval();
await recoveryTests.testAudioRecoveryHearsUnnamedAndHonorsExclusions();
await recoveryTests.testProjectSwitcherAtTop();
const alternativeTests=await import('./sfx-alternatives.test.js');
await alternativeTests.testAlternativesSurviveStrictSelection();
await alternativeTests.testAlternativeCardsKeepPreviewAndStageReplacement();
await alternativeTests.testLegacyAlternativesLoadWithoutEditing();
await alternativeTests.testAlternativeSearchesAreSerialized();
console.log('Audition alternatives and preserved preview checks passed');

const versionTests=await import('./sfx-save-version-ui.test.js');
await versionTests.testNamedVersionDialog();
await versionTests.testNamedVersionFailureCanRetryAndCancel();
await versionTests.testNamedVersionExplainsPendingEdits();
await versionTests.testNamedVersionReloadRetryDoesNotSaveTwice();
await versionTests.testNamedVersionHttpPersistence();
console.log('Named version dialog, retries and persisted history checks passed');
const timingRegression=await import('./sfx-timing-regression.test.js');
timingRegression.testOrdinaryStepsDoNotAddDebris();
timingRegression.testChestMovementDoesNotSearchForImpact();
await timingRegression.testOutputModeTimingAndReviewSafety();
await timingRegression.testAudioSelectionDoesNotInventPurityScope();
await timingRegression.testAnalysisUsesReadableFrames();
await timingRegression.testFocusedReviewAddsMissingKeyAction();
await timingRegression.testContactReviewUsesActorDetailAndContactBoundary();
timingRegression.testBossMotionRequiresAudioReview();
timingRegression.testBossGroundSlamDoesNotAddUnsupportedPostImpactNoise();
timingRegression.testFrameLabelsUseDecodedTimestamps();
await (await import('./sfx-source-review.test.js')).testContactSourceReviewIsolatesOneImpact();
await timingRegression.testVisualReanalysisRetainsSoundDirection();
timingRegression.testExcludedAudioDoesNotAffectMix();
await timingRegression.testSfxSelectionRejectsEmbeddedMusic();
console.log('Timing mode, replacement safety and step layer checks passed');
