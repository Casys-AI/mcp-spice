import {
  SPICE_DC_SWEEP_URI,
  SPICE_OPERATING_POINT_URI,
  SPICE_RESULT_SCHEMA_IDS,
  SPICE_SIMULATION_OUTCOME_URI,
  SPICE_SIMULATION_RECEIPT_URI,
  SPICE_TRANSIENT_RESULT_URI,
  SPICE_VIEW_APP_ID,
  SPICE_VIEW_APP_TITLE,
  SPICE_VIEW_APP_VERSION,
} from "./constants.ts";
import { SPICE_COMPONENT_KEYS } from "./simulation-result/src/catalog.ts";
import { SPICE_RECEIPT_COMPONENT_KEYS } from "./simulation-receipt/src/catalog.ts";

const VIEW_APP_MANIFEST_SCHEMA = "io.casys.mcp.view-app-manifest/1.0" as const;

const resultComponents = {
  [SPICE_COMPONENT_KEYS.simulationResult]: {
    title: "Simulation result",
    description:
      "One compact operating-point, reduced DC sweep, reduced transient, or typed failure.",
  },
  [SPICE_COMPONENT_KEYS.nodeStatistics]: {
    title: "Node statistics",
    description:
      "Requested node voltages or reduced voltage statistics from the actual schema.",
  },
  [SPICE_COMPONENT_KEYS.currentStatistics]: {
    title: "Current statistics",
    description:
      "Requested branch currents or reduced current statistics from the actual schema.",
  },
  [SPICE_COMPONENT_KEYS.analysisFacts]: {
    title: "Analysis facts",
    description: "Sweep or transient window facts when the schema supplies them.",
  },
  [SPICE_COMPONENT_KEYS.receiptProvenance]: {
    title: "Documentary receipt provenance",
    description:
      "Documentary identities from the live receipt reference or durable outcome envelope.",
  },
  [SPICE_COMPONENT_KEYS.notChecked]: {
    title: "Not checked",
    description: "Declared analysis limits copied from not_checked.",
  },
};

const resultDefaultSurface = {
  layout: { type: "stack", gap: "sm" },
  components: [
    { id: "result", component: SPICE_COMPONENT_KEYS.simulationResult },
  ],
};

const resultCatalog = {
  components: resultComponents,
  defaultSurface: resultDefaultSurface,
};

export const SPICE_VIEW_APP_MANIFEST = {
  schemaVersion: VIEW_APP_MANIFEST_SCHEMA,
  app: {
    id: SPICE_VIEW_APP_ID,
    title: SPICE_VIEW_APP_TITLE,
    version: SPICE_VIEW_APP_VERSION,
  },
  resources: [
    {
      uri: SPICE_OPERATING_POINT_URI,
      ownership: "whole-view",
      resultSchemas: [SPICE_RESULT_SCHEMA_IDS.operatingPoint],
      components: resultCatalog,
    },
    {
      uri: SPICE_DC_SWEEP_URI,
      ownership: "whole-view",
      resultSchemas: [SPICE_RESULT_SCHEMA_IDS.dcSweep],
      components: resultCatalog,
    },
    {
      uri: SPICE_TRANSIENT_RESULT_URI,
      ownership: "whole-view",
      resultSchemas: [SPICE_RESULT_SCHEMA_IDS.transientResult],
      components: resultCatalog,
    },
    {
      uri: SPICE_SIMULATION_OUTCOME_URI,
      ownership: "whole-view",
      resultSchemas: [
        SPICE_RESULT_SCHEMA_IDS.operatingPoint,
        SPICE_RESULT_SCHEMA_IDS.dcSweep,
        SPICE_RESULT_SCHEMA_IDS.transientResult,
        SPICE_RESULT_SCHEMA_IDS.simulationOutcome,
      ],
      components: resultCatalog,
    },
    {
      uri: SPICE_SIMULATION_RECEIPT_URI,
      ownership: "whole-view",
      resultSchemas: [SPICE_RESULT_SCHEMA_IDS.simulationReceipt],
      components: {
        components: {
          [SPICE_RECEIPT_COMPONENT_KEYS.receipt]: {
            title: "Simulation receipt",
            description:
              "One documentary receipt identity with the literal execution_state.",
          },
          [SPICE_RECEIPT_COMPONENT_KEYS.identities]: {
            title: "Receipt identities",
            description: "SHA-256 identities bound by the documentary receipt.",
          },
          [SPICE_RECEIPT_COMPONENT_KEYS.runtimeIdentity]: {
            title: "Runtime identity",
            description: "Provider, budget, Deno, and ngspice identity fields.",
          },
          [SPICE_RECEIPT_COMPONENT_KEYS.normalizedRequest]: {
            title: "Normalized request",
            description: "Canonical request fields stored on the receipt.",
          },
        },
        defaultSurface: {
          layout: { type: "stack", gap: "sm" },
          components: [
            { id: "receipt", component: SPICE_RECEIPT_COMPONENT_KEYS.receipt },
          ],
        },
      },
    },
  ],
} as const;
