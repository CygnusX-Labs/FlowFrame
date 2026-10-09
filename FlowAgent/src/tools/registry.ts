import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import YAML from 'yaml';
import type { FlowAgentConfig } from '../config';

export function readYaml(file: string): unknown {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function missing(file: string) {
  return {
    ok: false,
    error: `文件不存在: ${file}`,
    hint: '确认 FLOW_WORKFLOW_ROOT 指向含 agent/ 与 rules/manifests/ 资产的 Flow 仓库',
  };
}

interface ManifestDoc {
  module?: { id?: string; snakefile?: string; [k: string]: unknown };
  rules?: ManifestRule[];
}

interface ManifestRule {
  name: string;
  summary?: string;
  dynamic?: boolean;
  per_sample?: boolean;
  inputs?: { name: string; port?: string; [k: string]: unknown }[];
  outputs?: { name: string; port?: string; [k: string]: unknown }[];
  config_requires?: string[];
  [k: string]: unknown;
}

export interface LoadedManifest {
  moduleId: string;
  snakefile: string;
  sourceRef: string;
  rules: ManifestRule[];
}

export function loadManifests(root: string): LoadedManifest[] {
  const dir = path.join(root, 'rules', 'manifests');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.manifest.yaml'))
    .sort()
    .map((f) => {
      const doc = readYaml(path.join(dir, f)) as ManifestDoc;
      const moduleId = doc.module?.id ?? f.replace(/\.manifest\.yaml$/, '');
      return {
        moduleId,
        snakefile: doc.module?.snakefile ?? '',
        sourceRef: `rules/manifests/${f}`,
        rules: doc.rules ?? [],
      };
    });
}

export function createRegistryTools(cfg: FlowAgentConfig) {
  const root = cfg.workflowRoot;

  const query_catalog = tool({
    description:
      '查询产物目录 agent/catalog.yaml:用户会直接开口要的最终交付物(deliverable)及其 snakemake target 路径。SOP 第一步。关键词同时匹配 name/description/keywords/synonyms(同义词表,防漏召回)。返回紧凑摘要。',
    inputSchema: z.object({
      keyword: z.string().optional().describe('关键词过滤(匹配 name/description/keywords/synonyms),省略返回全部'),
    }),
    execute: async ({ keyword }) => {
      const file = path.join(root, 'agent', 'catalog.yaml');
      if (!fs.existsSync(file)) return missing(file);
      const doc = readYaml(file) as { deliverables?: any[] };
      const items = doc?.deliverables ?? [];
      const kw = keyword?.toLowerCase();
      const hit = items.filter(
        (d) =>
          !kw ||
          [d.name, d.description, ...(d.keywords ?? []), ...(d.synonyms ?? []), ...(d.tags ?? [])]
            .join(' ')
            .toLowerCase()
            .includes(kw),
      );
      return {
        ok: true,
        count: hit.length,
        deliverables: hit.map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          targets: d.targets,
          keywords: d.keywords,
          synonyms: d.synonyms,
        })),
      };
    },
  });

  const query_ports = tool({
    description:
      '查询端口注册表 agent/ports.yaml:语义化端口类型(reads.r1.fastq / qc.fastqc.zip 等)及其生产者/消费者 rule。给 port 名取详情,省略则返回全部端口摘要。新端口类型必须先登记进该文件。',
    inputSchema: z.object({
      port: z.string().optional().describe('端口类型名,如 qc.fastqc.zip;省略返回全部摘要'),
    }),
    execute: async ({ port }) => {
      const file = path.join(root, 'agent', 'ports.yaml');
      if (!fs.existsSync(file)) return missing(file);
      const ports = (readYaml(file) as { ports?: Record<string, any> })?.ports ?? {};
      if (port) {
        const entry = ports[port];
        if (!entry) {
          return { ok: false, error: `端口未登记: ${port}`, registered: Object.keys(ports) };
        }
        return { ok: true, port, ...entry };
      }
      return {
        ok: true,
        count: Object.keys(ports).length,
        ports: Object.entries(ports).map(([name, p]) => ({
          port: name,
          description: p.description,
          producers: p.producers ?? [],
          consumers: p.consumers ?? [],
          external: p.external === true,
        })),
      };
    },
  });

  const query_rules = tool({
    description:
      '检索全部 rule manifest 的紧凑摘要(规则名/模块/一句话说明/dynamic 标记/产出与消费端口)。按产出端口、消费端口、模块或关键词过滤。',
    inputSchema: z.object({
      produces_port: z.string().optional().describe('只保留产出该端口的 rule'),
      consumes_port: z.string().optional().describe('只保留消费该端口的 rule'),
      module: z.string().optional().describe('按模块 id 过滤,如 03.short_read_qc'),
      keyword: z.string().optional().describe('按 summary 关键词过滤'),
    }),
    execute: async ({ produces_port, consumes_port, module, keyword }) => {
      const manifests = loadManifests(root);
      if (manifests.length === 0) return missing(path.join(root, 'rules', 'manifests'));
      const kw = keyword?.toLowerCase();
      const out = [];
      for (const m of manifests) {
        if (module && m.moduleId !== module) continue;
        for (const r of m.rules) {
          const produces = (r.outputs ?? []).map((o) => o.port).filter(Boolean);
          const consumes = (r.inputs ?? []).map((i) => i.port).filter(Boolean);
          if (produces_port && !produces.includes(produces_port)) continue;
          if (consumes_port && !consumes.includes(consumes_port)) continue;
          if (kw && !(r.summary ?? '').toLowerCase().includes(kw) && !r.name.includes(kw)) continue;
          out.push({
            rule: r.name,
            module: m.moduleId,
            summary: r.summary,
            dynamic: r.dynamic === true,
            produces,
            consumes,
            source_ref: `${m.sourceRef}#rules[name=${r.name}]`,
          });
        }
      }
      return { ok: true, count: out.length, rules: out };
    },
  });

  const get_rule = tool({
    description:
      '取单个 rule 的完整 manifest 条目(input/output pattern、config_requires、dynamic、conda、resources_tier 等)。仅在组链真正用到时调用,不要批量拉取。',
    inputSchema: z.object({ rule_name: z.string() }),
    execute: async ({ rule_name }) => {
      for (const m of loadManifests(root)) {
        const r = m.rules.find((x) => x.name === rule_name);
        if (r) {
          return {
            ok: true,
            module: m.moduleId,
            snakefile: m.snakefile,
            source_ref: `${m.sourceRef}#rules[name=${r.name}]`,
            rule: r,
          };
        }
      }
      const available = loadManifests(root).flatMap((m) => m.rules.map((r) => r.name));
      return { ok: false, error: `rule 不存在或未建档: ${rule_name}`, available };
    },
  });

  return { query_catalog, query_ports, query_rules, get_rule };
}
