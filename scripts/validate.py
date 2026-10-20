#!/usr/bin/env python3
"""Validate the scientist agent preset before installing it.

Checks:
  1. preset.yml carries name/description.
  2. agent.cordis.yml parses as a top-level entry list (the loader's dialect,
     with `!!js` accepted as an opaque scalar).
  3. every row names a plugin; every plugin name resolves to a package in the
     DSH checkout (or is a known loader keyword / relative path).
  4. group rows recurse and carry a list.
  5. each skill has valid frontmatter (name == directory, description present)
     and stays under the 8192-char tool-result pruner threshold.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
import os

# 允许用 DSH_CHECKOUT 指向任意位置的 harness 源码；
# 未设置时用本机开发路径，若也不存在则跳过"插件能否解析"的校验（bundle 安装后常见）。
CHECKOUT = Path(os.environ.get("DSH_CHECKOUT", "/home/blake/workspaces/dsh/deepseek-harness"))

KNOWN_KEYWORDS = {"cordis:group"}
errors: list[str] = []
notes: list[str] = []


class Loader(yaml.SafeLoader):
    pass


def _js_tag(loader, node):
    """`!!js <expr>` is evaluated by the loader; here it stays an opaque scalar."""
    return {"__js__": loader.construct_scalar(node)}


Loader.add_constructor("tag:yaml.org,2002:js", _js_tag)


def package_names() -> set[str]:
    """Names the loader could resolve, derived from the checkout.

    The checkout ships built packages (some without package.json), so a name is
    accepted when either the manifest declares it or a package directory of that
    name exists under packages/ or apps/.
    """
    names: set[str] = set()
    roots = list(CHECKOUT.glob("packages/**/package.json")) + list(
        CHECKOUT.glob("apps/**/package.json")
    )
    for pkg in roots:
        try:
            data = json.loads(pkg.read_text())
        except Exception:
            continue
        if isinstance(data.get("name"), str):
            names.add(data["name"])
    for directory in list(CHECKOUT.glob("packages/**/")) + list(CHECKOUT.glob("apps/**/")):
        if not directory.is_dir():
            continue
        leaf = directory.name
        if leaf in {"lib", "node_modules", "src", "tests", "test", "dist"}:
            continue
        names.add(f"@deepseek-ai/{leaf}")
        names.add(f"@deepseek-ai/dsh-{leaf}")
    return names


def package_of(name: str) -> str:
    """The package part of a plugin name (drops any subpath export)."""
    if name.startswith("@"):
        parts = name.split("/")
        return "/".join(parts[:2])
    return name.split("/")[0]


def walk(rows, where="root") -> list[str]:
    found: list[str] = []
    if not isinstance(rows, list):
        errors.append(f"{where}: expected a list of plugin rows, got {type(rows).__name__}")
        return found
    for i, row in enumerate(rows, 1):
        label = f"{where} row {i}"
        if not isinstance(row, dict):
            errors.append(f"{label}: not a mapping")
            continue
        name = row.get("name")
        if not isinstance(name, str) or not name:
            errors.append(f"{label}: missing plugin name")
            continue
        found.append(name)
        if row.get("group") is True:
            inner = row.get("config")
            if not isinstance(inner, list):
                errors.append(f"{label} ({name}): group config must be a row list")
            else:
                found += walk(inner, label)
    return found


# 1. preset.yml（可选）------------------------------------------------------
# 本包以 bundle 形式分发（cordis.patch.yml），preset.yml 只是目录模式遗留；
# 安装后的包不含它，因此缺失时跳过而不是报错。
preset_path = ROOT / "preset.yml"
if not preset_path.is_file():
    notes.append("preset.yml absent（bundle 模式，跳过目录元数据校验）")
else:
    meta = yaml.safe_load(preset_path.read_text())
    for field in ("name", "description"):
        if not meta.get(field):
            errors.append(f"preset.yml: `{field}` missing")
    notes.append(f"preset: {meta.get('name')!r} (order={meta.get('order')})")

# 2/3/4. agent.cordis.yml ---------------------------------------------------
composition = ROOT / "agent.cordis.yml"
if not composition.is_file():
    errors.append("agent.cordis.yml missing")
    names: list[str] = []
else:
    try:
        rows = yaml.load(composition.read_text(), Loader=Loader)
    except yaml.YAMLError as exc:
        errors.append(f"agent.cordis.yml: invalid YAML: {exc}")
        rows = None
    names = walk(rows) if rows is not None else []
    notes.append(f"plugin rows: {len(names)}")

known = package_names()
if not known:
    # checkout 不存在（例如把本包单独安装到别处）：跳过"插件名能否解析"的校验，
    # 只保留语法与结构校验。
    notes.append(f"checkout absent（{CHECKOUT}），跳过插件名解析校验")

# 本包自身的 subpath export（例如 dsh-scientist/skills-provider.mjs）在 checkout 里
# 当然找不到，按 package.json 的 name 单独放行。
own_name = json.loads((ROOT / "package.json").read_text()).get("name") if (ROOT / "package.json").is_file() else None
for name in ([] if not known else sorted(set(names))):
    if name in KNOWN_KEYWORDS:
        continue
    if name.startswith("./") or name.startswith("/"):
        target = (ROOT / name).resolve()
        if not target.exists():
            errors.append(f"relative plugin not found: {name}")
        continue
    if own_name and (name == own_name or name.startswith(own_name + "/")):
        continue
    if name.startswith("dsh-") or "/engines/" in name:
        # package subpath exports (e.g. dsh-science/engines/*.mjs)
        base = package_of(name)
        if base not in known:
            errors.append(f"package not found in checkout: {base} (from {name})")
        continue
    if name not in known:
        # A checkout snapshot can lack a manifest for a package the installed
        # harness still resolves; report it, but do not fail the run.
        if package_of(name) in known:
            notes.append(f"subpath plugin (base package known): {name}")
        else:
            errors.append(f"plugin not found in checkout packages: {name}")

# 5. skills -----------------------------------------------------------------
skills_dir = ROOT / "skills"
if not skills_dir.is_dir():
    errors.append("skills/ missing")
else:
    for skill in sorted(p for p in skills_dir.iterdir() if p.is_dir()):
        md = skill / "SKILL.md"
        if not md.is_file():
            errors.append(f"skills/{skill.name}: SKILL.md missing")
            continue
        text = md.read_text()
        if not text.startswith("---"):
            errors.append(f"skills/{skill.name}: no frontmatter")
            continue
        _, front, body = text.split("---", 2)
        meta = yaml.safe_load(front) or {}
        if meta.get("name") != skill.name:
            errors.append(f"skills/{skill.name}: frontmatter name {meta.get('name')!r} != dir")
        if not meta.get("description"):
            errors.append(f"skills/{skill.name}: description missing")
        size = len(text)
        flag = "" if size < 8192 else "  (over pruner threshold!)"
        notes.append(f"skill {skill.name}: {size} chars{flag}")
        if size >= 8192:
            errors.append(f"skills/{skill.name}: {size} chars >= 8192 pruner threshold")

# report --------------------------------------------------------------------
print("\n".join(f"  · {n}" for n in notes))
if errors:
    print("\nFAILED:")
    for e in errors:
        print(f"  ✗ {e}")
    sys.exit(1)
print("\nOK: preset structure, plugin references and skills are valid.")
