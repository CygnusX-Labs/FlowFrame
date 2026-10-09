本分析流程是基于 Flow Framework — 多组学通用流程架构规范 v2.0 继续创建，关于该规范更加详细的细节见: https://github.com/xsx123123/FlowFrame

# Flow Framework 通用模板文件

来源：RNAFlow（生产环境参考实现）。创建新 Flow 时按以下分类使用。

**注意**：所有基于本规范创建的 Flow 流程，其 `README.md` 最前面（第一行）必须包含上方这行来源声明（位于所有其他内容之前）。

## 直接复制（通用层，所有 Flow 逐字一致）

| 文件 | 用途 |
|------|------|
| `rules/01.common.smk` | 导入 utils + logger 初始化 |
| `rules/02.file_convert_md5.smk` | FASTQ 标准化 + MD5 校验 |
| `rules/03.short_read_qc.smk` | FastQC + MultiQC |
| `rules/13.deliver.smk` | 交付（通用接口） |
| `rules/14.Report.smk` | 报告（通用接口） |
| `rules/utils/__init__.py` | 包标记 |
| `rules/utils/id_convert.py` | 样本表/对比表解析 |
| `rules/utils/validate.py` | 配置验证 |
| `rules/utils/reference_update.py` | 参考路径解析 |
| `rules/utils/resource_manager.py` | HPC 资源 profile |
| `config/cluster_config.yaml` | 资源 profile + clusters 映射 |
| `.gitmodules` | Git submodule 配置 |
| `.gitignore` | 仓库卫生 |
| `envs/fastqc.yaml` | FastQC 环境 |
| `envs/multiqc.yaml` | MultiQC 环境 |
| `envs/fastp.yaml` | fastp 环境 |
| `envs/fastq_screen.yaml` | FastQ Screen 环境 |

## 适配改写（改配置值/键名，结构不变）

| 文件 | 改什么 |
|------|--------|
| `snakefile` | `index_keys`、`required_columns`、include 列表 |
| `config/config.yaml` | `pipeline_version`、模块开关、软件路径 |
| `config/reference.yaml` | 本流程的 index 键和路径 |
| `config/run_parameter.yaml` | 线程/内存/工具参数 |
| `schema/config.schema.yaml` | 按本流程配置结构重写 |
| `rules/utils/common.py` | `MODULE_DEPENDENCIES` + `MODULE_COLLECTORS` |
| `rules/utils/datadeliver.py` | 收集器函数 |
| `examples/analysisyaml.example.yaml` | 脱敏项目配置示例 |
| `monitor_config.yaml` | `omichub_flow_id` 改为本流程标识 |

## 从零编写（组学专用）

- `rules/04.*.smk` ~ `rules/N-2.*.smk`
- `rules/utils/tools.py`
- `envs/<组学工具>.yaml`
- `scripts/`
- `config/samples.csv`（按组学扩展列）

## 使用方式

```bash
# 创建新 Flow 时，从本目录复制通用层
cp -r <skill_path>/assets/templates/rules/01.common.smk <X>Flow/rules/
cp -r <skill_path>/assets/templates/rules/02.file_convert_md5.smk <X>Flow/rules/
cp -r <skill_path>/assets/templates/rules/03.short_read_qc.smk <X>Flow/rules/
cp -r <skill_path>/assets/templates/rules/utils/ <X>Flow/rules/utils/
cp <skill_path>/assets/templates/config/cluster_config.yaml <X>Flow/config/
cp <skill_path>/assets/templates/snakefile <X>Flow/snakefile
# ... 然后按 SKILL.md §阶段 2-5 适配
```
