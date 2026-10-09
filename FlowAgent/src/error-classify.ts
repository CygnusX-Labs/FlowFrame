/**
 * 报错分类与签名归一化(审核手册阶段 1 第 2 项,对应原评审 #6):
 * - 签名 = 异常类型 | rule 名 | 消息骨架(去除引号内容/路径/数字),保证同类报错
 *   (如路径不同的 MissingInput)归入同一签名,熔断才能触发;
 * - 分桶决定重试策略:
 *   retryable   —— MissingInput/歧义 rule/环/KeyError 等,可修复重试,计入熔断;
 *   sample_table—— 样本表类(文件/列缺失、通配符冲突),直接升级人工,不计熔断;
 *   transient   —— OOM/节点瞬断/超时,自动续跑/OOM 加资源重试,不计熔断;
 *   unknown     —— 未识别类型,按可修复处理(计入熔断),保守。
 */
export type ErrorBucket = 'retryable' | 'sample_table' | 'transient' | 'unknown';

export interface ErrorClass {
  signature: string;
  bucket: ErrorBucket;
  exception: string;
  rule?: string;
}

const RETRYABLE_EXCEPTIONS = new Set([
  'MissingInputException',
  'AmbiguousRuleException',
  'CyclicGraphException',
  'KeyError',
  'FileNotFoundError',
  'IncompleteFilesException',
  'WorkflowError',
  'AttributeError',
  'TypeError',
  'ValueError',
]);

const SAMPLE_TABLE_PATTERN =
  /WildcardError|samples?\.csv|units\.tsv|sample[_ ]?table|KeyError.*sample|Column[s]?\s+\S+\s+(missing|not found)|wildcard value/i;
const TRANSIENT_PATTERN =
  /out of memory|\bOOM\b|MemoryError|SIGKILL|\bKilled\b|node.*(fail|down|unreach)|timed?\s?out|connection.*(reset|refused|closed)|slurm.*(error|fail)|(exit status|exited with) (?!code=0\b)\d+|code=[1-9]\d*\b/i;

export function classifyError(output: string): ErrorClass {
  const exMatch = output.match(/([A-Za-z_][A-Za-z0-9_]*(?:Exception|Error))/);
  const exception = exMatch?.[1] ?? 'NonZeroExit';
  const rule = output.match(/in rule ([A-Za-z_]\w*)/)?.[1];

  // 消息骨架:取包含异常类型的首行,归一化后仍有区分度
  const line = output.split('\n').find((l) => l.includes(exception)) ?? '';
  const skeleton = line
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/(?:[A-Za-z0-9_.\-]+\/)+[A-Za-z0-9_.\-]*/g, '/…') // 含 / 的路径(含样本名维度)
    .replace(/\b\d+(?:\.\d+)?\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

  const signature = `${exception}|${rule ?? '-'}|${skeleton}`;

  let bucket: ErrorBucket;
  if (exception === 'WildcardError' || SAMPLE_TABLE_PATTERN.test(output)) bucket = 'sample_table';
  else if (TRANSIENT_PATTERN.test(output)) bucket = 'transient';
  else if (RETRYABLE_EXCEPTIONS.has(exception)) bucket = 'retryable';
  else bucket = 'unknown';

  return { signature, bucket, exception, rule };
}
