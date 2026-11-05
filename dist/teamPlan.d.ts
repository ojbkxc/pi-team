import { z } from 'zod/v4';
export declare function isValidTeamMemberName(name: string): boolean;
export declare const teamPlanRuntimeSchema: z.ZodObject<{
    providerId: z.ZodString;
    modelId: z.ZodString;
    effortLevel: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const teamPlanAgentSnapshotSchema: z.ZodObject<{
    systemPrompt: z.ZodString;
    tools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    effortLevel: z.ZodOptional<z.ZodString>;
    agentType: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
    sourceIdentity: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"file">;
        path: z.ZodString;
        sha256: z.ZodString;
    }, z.core.$loose>, z.ZodObject<{
        kind: z.ZodLiteral<"builtin">;
    }, z.core.$loose>, z.ZodObject<{
        kind: z.ZodLiteral<"session">;
    }, z.core.$loose>], "kind">>;
    description: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    provider: z.ZodOptional<z.ZodString>;
    permissionMode: z.ZodOptional<z.ZodString>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    memory: z.ZodOptional<z.ZodString>;
    hooks: z.ZodOptional<z.ZodUnknown>;
    maxTurns: z.ZodOptional<z.ZodNumber>;
    omitClaudeMd: z.ZodOptional<z.ZodBoolean>;
    mcpServers: z.ZodOptional<z.ZodUnknown>;
    initialPrompt: z.ZodOptional<z.ZodString>;
    isolation: z.ZodOptional<z.ZodString>;
    configurationError: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const teamPlanMemberSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    agentType: z.ZodString;
    prompt: z.ZodString;
    runtime: z.ZodObject<{
        providerId: z.ZodString;
        modelId: z.ZodString;
        effortLevel: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    suggestedRuntime: z.ZodOptional<z.ZodObject<{
        providerId: z.ZodString;
        modelId: z.ZodString;
        effortLevel: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    reason: z.ZodOptional<z.ZodString>;
    difficulty: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>>;
    agentSnapshot: z.ZodOptional<z.ZodObject<{
        systemPrompt: z.ZodString;
        tools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        effortLevel: z.ZodOptional<z.ZodString>;
        agentType: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
        sourceIdentity: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            path: z.ZodString;
            sha256: z.ZodString;
        }, z.core.$loose>, z.ZodObject<{
            kind: z.ZodLiteral<"builtin">;
        }, z.core.$loose>, z.ZodObject<{
            kind: z.ZodLiteral<"session">;
        }, z.core.$loose>], "kind">>;
        description: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        provider: z.ZodOptional<z.ZodString>;
        permissionMode: z.ZodOptional<z.ZodString>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        memory: z.ZodOptional<z.ZodString>;
        hooks: z.ZodOptional<z.ZodUnknown>;
        maxTurns: z.ZodOptional<z.ZodNumber>;
        omitClaudeMd: z.ZodOptional<z.ZodBoolean>;
        mcpServers: z.ZodOptional<z.ZodUnknown>;
        initialPrompt: z.ZodOptional<z.ZodString>;
        isolation: z.ZodOptional<z.ZodString>;
        configurationError: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export declare const teamPlanTaskSchema: z.ZodObject<{
    id: z.ZodString;
    subject: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    ownerId: z.ZodOptional<z.ZodString>;
    dependencies: z.ZodArray<z.ZodString>;
}, z.core.$loose>;
export declare const teamPlanRecordSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    planId: z.ZodString;
    sessionId: z.ZodString;
    teamName: z.ZodString;
    incarnationId: z.ZodString;
    revision: z.ZodNumber;
    state: z.ZodEnum<{
        running: "running";
        draft: "draft";
        review_pending: "review_pending";
        launching: "launching";
        launch_failed: "launch_failed";
        cancelled: "cancelled";
        interrupted: "interrupted";
    }>;
    workDir: z.ZodString;
    leaderRuntime: z.ZodObject<{
        providerId: z.ZodString;
        modelId: z.ZodString;
        effortLevel: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    agentCatalog: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        systemPrompt: z.ZodString;
        tools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        effortLevel: z.ZodOptional<z.ZodString>;
        agentType: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
        sourceIdentity: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            path: z.ZodString;
            sha256: z.ZodString;
        }, z.core.$loose>, z.ZodObject<{
            kind: z.ZodLiteral<"builtin">;
        }, z.core.$loose>, z.ZodObject<{
            kind: z.ZodLiteral<"session">;
        }, z.core.$loose>], "kind">>;
        description: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        provider: z.ZodOptional<z.ZodString>;
        permissionMode: z.ZodOptional<z.ZodString>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        memory: z.ZodOptional<z.ZodString>;
        hooks: z.ZodOptional<z.ZodUnknown>;
        maxTurns: z.ZodOptional<z.ZodNumber>;
        omitClaudeMd: z.ZodOptional<z.ZodBoolean>;
        mcpServers: z.ZodOptional<z.ZodUnknown>;
        initialPrompt: z.ZodOptional<z.ZodString>;
        isolation: z.ZodOptional<z.ZodString>;
        configurationError: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>>;
    members: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        agentType: z.ZodString;
        prompt: z.ZodString;
        runtime: z.ZodObject<{
            providerId: z.ZodString;
            modelId: z.ZodString;
            effortLevel: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>;
        suggestedRuntime: z.ZodOptional<z.ZodObject<{
            providerId: z.ZodString;
            modelId: z.ZodString;
            effortLevel: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        reason: z.ZodOptional<z.ZodString>;
        difficulty: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        agentSnapshot: z.ZodOptional<z.ZodObject<{
            systemPrompt: z.ZodString;
            tools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            effortLevel: z.ZodOptional<z.ZodString>;
            agentType: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
            sourceIdentity: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"file">;
                path: z.ZodString;
                sha256: z.ZodString;
            }, z.core.$loose>, z.ZodObject<{
                kind: z.ZodLiteral<"builtin">;
            }, z.core.$loose>, z.ZodObject<{
                kind: z.ZodLiteral<"session">;
            }, z.core.$loose>], "kind">>;
            description: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            provider: z.ZodOptional<z.ZodString>;
            permissionMode: z.ZodOptional<z.ZodString>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            memory: z.ZodOptional<z.ZodString>;
            hooks: z.ZodOptional<z.ZodUnknown>;
            maxTurns: z.ZodOptional<z.ZodNumber>;
            omitClaudeMd: z.ZodOptional<z.ZodBoolean>;
            mcpServers: z.ZodOptional<z.ZodUnknown>;
            initialPrompt: z.ZodOptional<z.ZodString>;
            isolation: z.ZodOptional<z.ZodString>;
            configurationError: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        subject: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        ownerId: z.ZodOptional<z.ZodString>;
        dependencies: z.ZodArray<z.ZodString>;
    }, z.core.$loose>>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
    parentPlanId: z.ZodOptional<z.ZodString>;
    feedback: z.ZodOptional<z.ZodString>;
    approvedSnapshot: z.ZodOptional<z.ZodObject<{
        revision: z.ZodNumber;
        members: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            agentType: z.ZodString;
            prompt: z.ZodString;
            runtime: z.ZodObject<{
                providerId: z.ZodString;
                modelId: z.ZodString;
                effortLevel: z.ZodOptional<z.ZodString>;
            }, z.core.$loose>;
            suggestedRuntime: z.ZodOptional<z.ZodObject<{
                providerId: z.ZodString;
                modelId: z.ZodString;
                effortLevel: z.ZodOptional<z.ZodString>;
            }, z.core.$loose>>;
            reason: z.ZodOptional<z.ZodString>;
            difficulty: z.ZodOptional<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
            }>>;
            agentSnapshot: z.ZodOptional<z.ZodObject<{
                systemPrompt: z.ZodString;
                tools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                effortLevel: z.ZodOptional<z.ZodString>;
                agentType: z.ZodOptional<z.ZodString>;
                source: z.ZodOptional<z.ZodString>;
                sourceIdentity: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    kind: z.ZodLiteral<"file">;
                    path: z.ZodString;
                    sha256: z.ZodString;
                }, z.core.$loose>, z.ZodObject<{
                    kind: z.ZodLiteral<"builtin">;
                }, z.core.$loose>, z.ZodObject<{
                    kind: z.ZodLiteral<"session">;
                }, z.core.$loose>], "kind">>;
                description: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                provider: z.ZodOptional<z.ZodString>;
                permissionMode: z.ZodOptional<z.ZodString>;
                skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                memory: z.ZodOptional<z.ZodString>;
                hooks: z.ZodOptional<z.ZodUnknown>;
                maxTurns: z.ZodOptional<z.ZodNumber>;
                omitClaudeMd: z.ZodOptional<z.ZodBoolean>;
                mcpServers: z.ZodOptional<z.ZodUnknown>;
                initialPrompt: z.ZodOptional<z.ZodString>;
                isolation: z.ZodOptional<z.ZodString>;
                configurationError: z.ZodOptional<z.ZodString>;
            }, z.core.$loose>>;
        }, z.core.$loose>>;
        tasks: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            subject: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            ownerId: z.ZodOptional<z.ZodString>;
            dependencies: z.ZodArray<z.ZodString>;
        }, z.core.$loose>>;
        leaderRuntime: z.ZodObject<{
            providerId: z.ZodString;
            modelId: z.ZodString;
            effortLevel: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>;
        approvedAt: z.ZodNumber;
        requestId: z.ZodString;
    }, z.core.$loose>>;
    launch: z.ZodOptional<z.ZodObject<{
        status: z.ZodEnum<{
            running: "running";
            failed: "failed";
            pending: "pending";
        }>;
        error: z.ZodOptional<z.ZodString>;
        memberIds: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export type TeamPlanAgentSnapshot = z.infer<typeof teamPlanAgentSnapshotSchema>;
export type TeamPlanRuntime = z.infer<typeof teamPlanRuntimeSchema>;
export type TeamPlanMember = z.infer<typeof teamPlanMemberSchema>;
export type TeamPlanTask = z.infer<typeof teamPlanTaskSchema>;
export type TeamPlanRecord = z.infer<typeof teamPlanRecordSchema>;
export type TeamPlanIdentity = Pick<TeamPlanRecord, 'planId' | 'sessionId' | 'incarnationId'> & {
    expectedRevision: number;
};
export type TeamPlanPatch = Partial<Pick<TeamPlanRecord, 'members' | 'tasks' | 'leaderRuntime' | 'feedback' | 'agentCatalog'>>;
export type TeamPlanAction = TeamPlanIdentity & {
    requestId: string;
    feedback?: string;
};
