// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    AppAgent,
    TranslatorDefinition,
    AppAgentManifest,
} from "@typeagent/agent-sdk";
import { getDispatcherConfig, getExternalAgentsConfig } from "../utils/config.js";
import { createRequire } from "module";
import path from "node:path";
import { promises as fs } from "node:fs";

import { createAgentProcessShim } from "./agentProcessShim.js";
import { AppAgentProvider } from "./agentProvider.js";
import { CommandHandlerContext } from "../handlers/common/commandHandlerContext.js";
import { loadInlineAgent } from "./inlineAgentHandlers.js";
import { fileURLToPath } from "node:url";

export type InlineAppAgentInfo = {
    type?: undefined;
} & AppAgentManifest;

const enum ExecutionMode {
    SeparateProcess = "separate",
    DispatcherProcess = "dispatcher",
}

export type ModuleAppAgentInfo = {
    type: "module";
    name: string;
    path?: string
    execMode?: ExecutionMode;
};

export type AgentInfo = (InlineAppAgentInfo | ModuleAppAgentInfo) & {
    imports?: string[]; // for @const import
};

function patchPaths(config: TranslatorDefinition, dir: string) {
    if (config.schema) {
        config.schema.schemaFile = path.resolve(dir, config.schema.schemaFile);
    }
    if (config.subTranslators) {
        for (const subTranslator of Object.values(config.subTranslators)) {
            patchPaths(subTranslator, dir);
        }
    }
}

async function loadModuleConfig(
    info: ModuleAppAgentInfo,
): Promise<AppAgentManifest> {
    const require = createRequire(import.meta.url);
    let modulePath = `${info.name}/agent/manifest`;
    if(info.path != undefined){
        modulePath = info.path.replace("file:/", "");
        modulePath = path.join(modulePath, `/agent/manifest`);
    }

    const manifestPath = require.resolve(modulePath);
    const config = require(manifestPath) as AppAgentManifest;
    patchPaths(config, path.dirname(manifestPath));
    return config;
}

async function loadDispatcherConfigs() {
    const infos = getDispatcherConfig().agents;
    const appAgents: Map<string, AppAgentManifest> = new Map();
    for (const [name, info] of Object.entries(infos)) {
        appAgents.set(
            name,
            info.type === "module" ? await loadModuleConfig(info) : info,
        );
    }
    return appAgents;
}

let appAgentConfigs: Map<string, AppAgentManifest> | undefined;
export async function getBuiltinAppAgentConfigs() {
    if (appAgentConfigs === undefined) {
        appAgentConfigs = await loadDispatcherConfigs();
    }
    return appAgentConfigs;
}

async function loadExternalAgentConfigs() {
    const infos = getExternalAgentsConfig().agents;
    const externalAgents: Map<string, AppAgentManifest> = new Map();
    for (const [name, info] of Object.entries(infos)) {
        externalAgents.set(
            name,
            info.type === "module" ? await loadModuleConfig(info) : info,
        );
    }
    return externalAgents;
}

let externalAgentConfigs: Map<string, AppAgentManifest> | undefined;
export async function getExternalAppAgentConfigs() {
    if (externalAgentConfigs === undefined) {
        externalAgentConfigs = await loadExternalAgentConfigs();
    }
    return externalAgentConfigs;
}


function enableExecutionMode() {
    return process.env.TYPEAGENT_EXECMODE !== "0";
}

async function loadModuleAgent(info: ModuleAppAgentInfo): Promise<AppAgent> {
    const execMode = info.execMode ?? ExecutionMode.SeparateProcess;

    let agentHandlerPath = info.path ? info.path.replace("file:", "") : "";
    agentHandlerPath = path.join(agentHandlerPath, `${info.name}/agent/handlers`);


    if (enableExecutionMode() && execMode === ExecutionMode.SeparateProcess) {
        return createAgentProcessShim(agentHandlerPath);
    }

    const module = await import(agentHandlerPath);
    if (typeof module.instantiate !== "function") {
        throw new Error(
            `Failed to load module agent ${info.name}: missing 'instantiate' function.`,
        );
    }
    return module.instantiate();
}

// Load on demand, doesn't unload for now
const moduleAgents = new Map<string, AppAgent>();
async function getModuleAgent(appAgentName: string) {
    const existing = moduleAgents.get(appAgentName);
    if (existing) return existing;
    const config = getDispatcherConfig().agents[appAgentName];
    if (config === undefined || config.type !== "module") {
        throw new Error(`Unable to load app agent name: ${appAgentName}`);
    }
    const agent = await loadModuleAgent(config);
    moduleAgents.set(appAgentName, agent);
    return agent;
}

const externalAgents = new Map<string, AppAgent>();
export function getExternalAppAgentProvider(
    context: CommandHandlerContext,
): AppAgentProvider {
    return {
        getAppAgentNames() {
            return Object.keys(getExternalAgentsConfig().agents);
        },
        async getAppAgentManifest(appAgentName: string) {
            const configs = await getExternalAppAgentConfigs();
            const config = configs.get(appAgentName);
            if (config === undefined) {
                throw new Error(`Invalid app agent: ${appAgentName}`);
            }
            return config;
        },
        async loadAppAgent(appAgentName: string) {
            const type = getExternalAgentsConfig().agents[appAgentName].type;
            return type === "module"
                ? await getModuleAgent(appAgentName)
                : loadInlineAgent(appAgentName, context);
        },
    };
}

export function getBuiltinAppAgentProvider(
    context: CommandHandlerContext,
): AppAgentProvider {
    return {
        getAppAgentNames() {
            return Object.keys(getDispatcherConfig().agents);
        },
        async getAppAgentManifest(appAgentName: string) {
            const configs = await getBuiltinAppAgentConfigs();
            const config = configs.get(appAgentName);
            if (config === undefined) {
                throw new Error(`Invalid app agent: ${appAgentName}`);
            }
            return config;
        },
        async loadAppAgent(appAgentName: string) {
            const type = getDispatcherConfig().agents[appAgentName].type;
            return type === "module"
                ? await getModuleAgent(appAgentName)
                : loadInlineAgent(appAgentName, context);
        },
    };
}
