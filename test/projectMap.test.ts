import { describe, expect, it } from "vitest";
import type { ProjectMap } from "../src/core/types";
import {
  checkedProjectMap,
  deploymentFacts,
  folderLevel,
  folderOutline,
  foldersOf,
  isContractFile,
  isDeploymentFile,
  mapMembers,
  mapView,
  outlineText
} from "../src/context/projectMap";
import { folderSummaryPrompt, overviewPrompt } from "../src/generation/prompts";
import { parsePriming } from "../src/generation/schema";

const files = [
  "README.md",
  "docs/guide.md",
  "services/bff/components/gqlapi/Dockerfile",
  "services/bff/components/gqlapi/go.mod",
  "services/bff/components/gqlapi/main.go",
  "services/bff/components/gqlapi/internal/graphql/schema/wearer.graphql",
  "services/bff/manifests/base/kustomization.yaml",
  "services/inventory/README.md",
  "services/inventory/api/async/asyncapi.yaml",
  "services/inventory/components/rest-api/go.mod",
  "services/inventory/components/rest-api/internal/handlers/devices.go",
  "services/inventory/database/docker-compose.yml",
  "websites/modules/bwmc/package.json",
  "websites/modules/bwmc/src/index.tsx",
  "tools/scripts/run.sh"
];

const map: ProjectMap = {
  summary: "A device management center with a web frontend and backend services.",
  parts: [
    { id: "services", path: "services", level: "group", name: "Backend services", summary: "The backend services." },
    { id: "bff", path: "services/bff", level: "component", name: "BFF", summary: "GraphQL API for the frontend." },
    { id: "inventory", path: "services/inventory", level: "component", name: "Inventory", summary: "Keeps the device inventory." },
    { id: "rest", path: "services/inventory/components/rest-api", level: "module", name: "REST API", summary: "Serves inventory over REST." },
    { id: "db", path: "services/inventory/database", level: "module", name: "Database", summary: "Stores devices." },
    { id: "web", path: "websites/modules/bwmc", level: "component", name: "Web frontend", summary: "The web app." },
    { id: "tools", path: "tools", level: "support", name: "Tools", summary: "Developer tools." },
    { id: "devices", level: "external", name: "Cameras", summary: "Devices in the field." }
  ],
  links: [
    { from: "web", to: "bff", label: "GraphQL" },
    { from: "bff", to: "rest", label: "REST" },
    { from: "rest", to: "db", label: "SQL" },
    { from: "devices", to: "rest", label: "MQTT" }
  ]
};

describe("the folder outline", () => {
  it("lists shallow folders and deeper ones with markers, connected to the root", () => {
    const outline = folderOutline(files);
    const byPath = new Map(outline.map((entry) => [entry.path, entry]));
    expect(byPath.get("")?.markers).toEqual(["README"]);
    expect(byPath.get("services")?.files).toBe(10);
    expect(byPath.get("services/bff/components/gqlapi")?.markers).toEqual(["Dockerfile", "entry point", "go.mod"]);
    expect(byPath.get("services/inventory/api/async")?.markers).toEqual(["AsyncAPI"]);
    expect(byPath.get("services/inventory/database")?.markers).toEqual(["Compose"]);
    // Folders on the way to a marker are listed, so the tree stays connected.
    expect(byPath.has("services/bff/components")).toBe(true);
    // Deep folders without markers are left out.
    expect(byPath.has("services/inventory/components/rest-api/internal/handlers")).toBe(false);
    expect(outlineText(outline)).toContain("services/bff/components/gqlapi/ 4 files; Dockerfile, entry point, go.mod");
  });

  it("recognizes contracts and deployment files", () => {
    expect(isContractFile("services/inventory/api/async/asyncapi.yaml")).toBe(true);
    expect(isContractFile("x/schema/wearer.graphql")).toBe(true);
    expect(isContractFile("x/config.yaml")).toBe(false);
    expect(isDeploymentFile("services/bff/manifests/base/deployment.yaml")).toBe(true);
    expect(isDeploymentFile("services/inventory/database/docker-compose.yml")).toBe(true);
    expect(isDeploymentFile("services/inventory/api/async/asyncapi.yaml")).toBe(false);
  });
});

describe("deployment facts", () => {
  it("keeps names from Kubernetes manifests and never values", () => {
    const facts = deploymentFacts([
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: gqlapi",
      "spec:",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: gqlapi",
      "          image: registry.example/gqlapi:1.2",
      "          ports:",
      "            - containerPort: 8080",
      "          env:",
      "            - name: INVENTORY_URL",
      "              value: http://inventory.internal:8080",
      "            - name: DB_PASSWORD",
      "              valueFrom:",
      "                secretKeyRef: { name: db, key: password }",
      "---",
      "kind: ConfigMap",
      "metadata:",
      "  name: settings",
      "data:",
      "  LOG_LEVEL: debug",
      "  API_TOKEN: hunter2"
    ].join("\n"));
    expect(facts).toContain("kinds: Deployment, ConfigMap");
    expect(facts).toContain("names: gqlapi, settings");
    expect(facts).toContain("images: registry.example/gqlapi:1.2");
    expect(facts).toContain("ports: 8080");
    expect(facts).toContain("environment variable names: INVENTORY_URL, DB_PASSWORD");
    expect(facts).toContain("config keys: LOG_LEVEL, API_TOKEN");
    expect(facts).not.toMatch(/inventory\.internal|hunter2|debug|password/);
  });

  it("keeps Compose services, dependencies, and environment names", () => {
    const facts = deploymentFacts([
      "services:",
      "  db:",
      "    image: postgres:16",
      "    ports:",
      "      - \"5432:5432\"",
      "    environment:",
      "      POSTGRES_PASSWORD: secret",
      "  api:",
      "    build: .",
      "    depends_on:",
      "      - db",
      "    environment:",
      "      - DATABASE_URL=postgres://user:pw@db/app"
    ].join("\n"));
    expect(facts).toContain("Compose services: db, api");
    expect(facts).toContain("depends on: db");
    expect(facts).toContain("environment variable names: POSTGRES_PASSWORD, DATABASE_URL");
    expect(facts).toContain("ports: 5432:5432");
    expect(facts).not.toMatch(/secret|user:pw/);
  });
});

describe("the project map", () => {
  it("keeps parts the repository has and links between kept parts", () => {
    const folders = foldersOf(files);
    const checked = checkedProjectMap({
      summary: " About the project. ",
      parts: [
        ...map.parts,
        { id: "ghost", path: "services/ghost", level: "component", name: "Ghost", summary: "Not there." },
        { id: "bff2", path: "services/bff/", level: "component", name: "Duplicate", summary: "Same folder." },
        { id: "up", path: "../outside", level: "component", name: "Escape", summary: "Outside the repository." }
      ],
      links: [
        ...map.links,
        { from: "web", to: "bff", label: "HTTP" },
        { from: "web", to: "ghost", label: "REST" },
        { from: "web", to: "web", label: "self" }
      ]
    }, (path) => folders.has(path));
    expect(checked.summary).toBe("About the project.");
    expect(checked.parts.map((part) => part.id)).toEqual(map.parts.map((part) => part.id));
    expect(checked.parts.find((part) => part.id === "devices")?.path).toBeUndefined();
    expect(checked.links).toHaveLength(4);
    expect(checked.links[0]).toEqual({ from: "web", to: "bff", label: "GraphQL, HTTP" });
  });

  it("gives every folder a zoom level", () => {
    expect(folderLevel(map, "")).toBe("project");
    expect(folderLevel(map, "services")).toBe("group");
    expect(folderLevel(map, "services/inventory")).toBe("component");
    expect(folderLevel(map, "services/inventory/api")).toBe("module");
    expect(folderLevel(map, "services/inventory/components/rest-api/internal")).toBe("module");
    expect(folderLevel(map, "tools/scripts")).toBe("support");
    expect(folderLevel(map, "websites")).toBe("folder");
    expect(folderLevel(undefined, "services")).toBe("folder");
  });

  it("draws the project as components and what is outside", () => {
    const view = mapView(map, "")!;
    expect(view.nodes.map((node) => `${node.id}:${node.place}`).sort()).toEqual(["bff:inside", "devices:external", "inventory:inside", "web:inside"]);
    expect(view.nodes.find((node) => node.id === "bff")?.group).toBe("Backend services");
    expect(view.edges).toEqual([
      { from: "web", to: "bff", label: "GraphQL" },
      { from: "bff", to: "inventory", label: "REST" },
      { from: "devices", to: "inventory", label: "MQTT" }
    ]);
  });

  it("draws a group's members with the outside parts they connect to", () => {
    const view = mapView(map, "services")!;
    expect(view.nodes.map((node) => `${node.id}:${node.place}`).sort()).toEqual(["bff:inside", "devices:external", "inventory:inside", "web:outside"]);
    expect(view.nodes.find((node) => node.id === "bff")?.group).toBeUndefined();
  });

  it("draws a component's modules, and nothing for modules or support folders", () => {
    const view = mapView(map, "services/inventory")!;
    expect(view.nodes.map((node) => `${node.id}:${node.place}`).sort()).toEqual(["bff:outside", "db:inside", "devices:external", "rest:inside"]);
    expect(view.edges).toContainEqual({ from: "rest", to: "db", label: "SQL" });
    expect(mapView(map, "services/inventory/components/rest-api")).toBeUndefined();
    expect(mapView(map, "tools")).toBeUndefined();
  });

  it("draws a component without modules with what it connects to", () => {
    const view = mapView(map, "services/bff")!;
    // Ends elsewhere in the repository are drawn as their outermost component.
    expect(view.nodes.map((node) => `${node.id}:${node.place}`).sort()).toEqual(["bff:inside", "inventory:outside", "web:outside"]);
    expect(view.edges).toContainEqual({ from: "bff", to: "inventory", label: "REST" });
  });

  it("lists a folder's direct members", () => {
    expect(mapMembers(map, "").map((part) => part.id)).toEqual(["services", "web", "tools", "devices"]);
    expect(mapMembers(map, "services").map((part) => part.id)).toEqual(["bff", "inventory"]);
  });
});

describe("priming replies and prompts", () => {
  const overview = { purpose: "p", components: "c", flows: "f", conventions: "v", uncertainties: "u", limitations: [] };

  it("reads the map leniently, so a broken map never costs the overview", () => {
    expect(parsePriming(overview).map).toEqual({ summary: "", parts: [], links: [] });
    const { map } = parsePriming({
      ...overview,
      map: {
        summary: "A project.",
        parts: [
          { id: "api", path: "services/api", level: "component", name: "API", summary: "Serves orders.", detail: "", offers: "REST", uses: "" },
          { id: "bad", path: "x", level: "planet", name: "Bad", summary: "" },
          "not a part"
        ],
        links: [{ from: "api", to: "db", label: "SQL" }, { from: "", to: "db" }]
      }
    });
    expect(map.parts).toEqual([{ id: "api", path: "services/api", level: "component", name: "API", summary: "Serves orders.", offers: "REST" }]);
    expect(map.links).toEqual([{ from: "api", to: "db", label: "SQL" }]);
    expect(() => parsePriming({ map: {} })).toThrow();
  });

  it("asks for component details only for detailed maps, and sends the folder outline", () => {
    const input = { repositoryName: "center", inventory: "--- README.md ---\nHi", languageIds: ["go"], folders: "services/ 3 files", mapDetail: "brief" as const };
    const [briefSystem, user] = overviewPrompt(input);
    expect(briefSystem).toContain("detail, offers, and uses are empty strings");
    expect(user).toContain("\"folderOutline\":\"services/ 3 files\"");
    const [detailedSystem] = overviewPrompt({ ...input, mapDetail: "detailed" });
    expect(detailedSystem).toContain("For components, detail is two to four plain sentences");
  });

  it("tells a folder summary what its level asks for", () => {
    const base = { repositoryName: "center", path: "services/api", parts: [], imports: [] };
    expect(folderSummaryPrompt({ ...base, level: "component", contracts: [{ path: "services/api/api/openapi.yaml", text: "openapi: 3.0.0" }] })[0]).toContain("In offers, say in one plain sentence");
    expect(folderSummaryPrompt({ ...base, level: "component", contracts: [{ path: "a.yaml", text: "x" }] })[1]).toContain("apiContracts");
    expect(folderSummaryPrompt({ ...base, level: "support" })[0]).toContain("Keep it brief");
    expect(folderSummaryPrompt(base)[0]).toContain("offers and uses are empty strings.");
  });
});
