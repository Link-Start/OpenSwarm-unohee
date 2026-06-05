// ============================================
// OpenSwarm - Code Registry GraphQL Resolvers
// Created: 2026-04-10
// Purpose: Query + Mutation 리졸버
// ============================================

import { getRegistryStore, type RegisterEntityInput, type UpdateEntityInput } from '../sqliteStore.js';
import { onEntityDeprecated, onEntityWarningAdded } from '../memoryBridge.js';
import type {
  CodeEntity, CodeEntityFilter, EntityStatus, WarningSeverity, WarningCategory, RelationType,
} from '../schema.js';

export const registryResolvers = {
  Query: {
    codeEntity: (_: unknown, { id }: { id: string }) => {
      return getRegistryStore().getEntity(id);
    },

    codeEntityByName: (_: unknown, { qualifiedName }: { qualifiedName: string }) => {
      return getRegistryStore().getEntityByName(qualifiedName);
    },

    codeEntities: (_: unknown, { filter }: { filter?: CodeEntityFilter }) => {
      return getRegistryStore().listEntities(filter);
    },

    fileBrief: (_: unknown, { filePath }: { filePath: string }) => {
      return getRegistryStore().fileBrief(filePath);
    },

    registryStats: (_: unknown, { projectId }: { projectId?: string }) => {
      return getRegistryStore().getStats(projectId);
    },

    deprecatedEntities: (_: unknown, { projectId }: { projectId?: string }) => {
      return getRegistryStore().deprecatedEntities(projectId);
    },

    untestedEntities: (_: unknown, { projectId }: { projectId?: string }) => {
      return getRegistryStore().untestedEntities(projectId);
    },

    highRiskEntities: (_: unknown, { projectId }: { projectId?: string }) => {
      return getRegistryStore().highRiskEntities(projectId);
    },

    entitiesByTag: (_: unknown, { tag, value }: { tag: string; value?: string }) => {
      return getRegistryStore().entitiesByTag(tag, value ?? undefined);
    },

    entityWarnings: (_: unknown, { severity }: { severity?: WarningSeverity }) => {
      return getRegistryStore().getUnresolvedWarnings(severity);
    },

    searchEntities: (_: unknown, { query, limit }: { query: string; limit?: number }) => {
      return getRegistryStore().searchEntities(query, limit ?? 20);
    },
  },

  Mutation: {
    registerEntity: (_: unknown, { input }: { input: RegisterEntityInput }) => {
      return getRegistryStore().registerEntity(input);
    },

    bulkRegisterEntities: (_: unknown, { input }: { input: RegisterEntityInput[] }) => {
      return getRegistryStore().bulkRegisterEntities(input);
    },

    updateEntity: (_: unknown, { id, input }: { id: string; input: UpdateEntityInput }) => {
      return getRegistryStore().updateEntity(id, input);
    },

    removeEntity: (_: unknown, { id }: { id: string }) => {
      return getRegistryStore().removeEntity(id);
    },

    deprecateEntity: (_: unknown, { id, reason }: { id: string; reason?: string }) => {
      const store = getRegistryStore();
      const entity = store.deprecateEntity(id, reason ?? undefined);
      if (entity) {
        onEntityDeprecated(entity).catch(err =>
          console.warn('[Registry] 메모리 브릿지 실패:', err)
        );
      }
      return entity;
    },

    changeEntityStatus: (_: unknown, { id, status, actor }: { id: string; status: EntityStatus; actor?: string }) => {
      return getRegistryStore().changeEntityStatus(id, status, actor ?? 'system');
    },

    addEntityTag: (_: unknown, { entityId, tag, value }: { entityId: string; tag: string; value?: string }) => {
      const store = getRegistryStore();
      store.addTag(entityId, tag, value ?? undefined);
      return store.getEntity(entityId);
    },

    removeEntityTag: (_: unknown, { entityId, tag }: { entityId: string; tag: string }) => {
      const store = getRegistryStore();
      store.removeTag(entityId, tag);
      return store.getEntity(entityId);
    },

    addEntityWarning: (_: unknown, { entityId, severity, category, message }: {
      entityId: string; severity: WarningSeverity; category: WarningCategory; message: string;
    }) => {
      const store = getRegistryStore();
      const warning = store.addWarning(entityId, severity, category, message);
      const entity = store.getEntity(entityId);
      if (entity) {
        onEntityWarningAdded(entity, warning).catch(err =>
          console.warn('[Registry] 메모리 브릿지 실패:', err)
        );
      }
      return warning;
    },

    resolveWarning: (_: unknown, { warningId }: { warningId: string }) => {
      return getRegistryStore().resolveWarning(warningId);
    },

    addEntityRelation: (_: unknown, { sourceId, targetId, relationType }: {
      sourceId: string; targetId: string; relationType: RelationType;
    }) => {
      getRegistryStore().addRelation(sourceId, targetId, relationType);
      return true;
    },

    removeEntityRelation: (_: unknown, { sourceId, targetId, relationType }: {
      sourceId: string; targetId: string; relationType: RelationType;
    }) => {
      getRegistryStore().removeRelation(sourceId, targetId, relationType);
      return true;
    },

    linkEntityToIssue: (_: unknown, { entityId, issueId }: { entityId: string; issueId: string }) => {
      getRegistryStore().linkIssue(entityId, issueId);
      return true;
    },

    unlinkEntityFromIssue: (_: unknown, { entityId, issueId }: { entityId: string; issueId: string }) => {
      getRegistryStore().unlinkIssue(entityId, issueId);
      return true;
    },

    linkEntityToMemory: (_: unknown, { entityId, memoryId }: { entityId: string; memoryId: string }) => {
      getRegistryStore().linkMemory(entityId, memoryId);
      return true;
    },

    addEntityNote: (_: unknown, { entityId, content, actor }: {
      entityId: string; content: string; actor?: string;
    }) => {
      return getRegistryStore().addEvent(entityId, 'note_added', {
        content,
        actor: actor ?? 'system',
      });
    },
  },

  // 필드 리졸버: CodeEntity.relations, CodeEntity.events
  CodeEntity: {
    relations: (entity: CodeEntity) => {
      return getRegistryStore().getRelations(entity.id);
    },
    events: (entity: CodeEntity, { limit }: { limit?: number }) => {
      return getRegistryStore().getEvents(entity.id, limit ?? 20);
    },
  },
};
