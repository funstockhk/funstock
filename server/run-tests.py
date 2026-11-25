#!/usr/bin/env python3
"""Internal preview API tests. Do not print the test password."""
import json, re, shutil, urllib.request, urllib.error, http.cookiejar
from pathlib import Path

pkg = Path(__file__).resolve().parents[1]
base = "http://127.0.0.1:8787"
results = []
PASSWORD = re.search(
    r"测试口令（两套账号共用）：`([^`]+)`",
    (pkg / "credentials.local.md").read_text(encoding="utf-8"),
).group(1)

def rec(name, passed, evidence):
    results.append({"name": name, "passed": bool(passed), "evidence": evidence})
    print(("PASS" if passed else "FAIL") + "  " + name + "  —  " + evidence)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
opener_noredirect = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(cj))

def req(method, path, data=None, cookies=True, allow_redirect=True):
    h = {}
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(base + path, data=body, headers=h, method=method)
    if not cookies:
        op = urllib.request.build_opener(NoRedirect) if not allow_redirect else urllib.request.build_opener()
    else:
        op = opener_noredirect if not allow_redirect else opener
    try:
        with op.open(r, timeout=20) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()

def api(action, payload=None, use_cookies=True):
    status, headers, raw = req("POST", "/api", {"action": action, "payload": payload or {}}, cookies=use_cookies)
    try:
        body = json.loads(raw.decode("utf-8"))
    except Exception:
        body = {"_raw": raw[:200].decode("utf-8", "replace")}
    return status, body

def has(raw, s):
    return s.encode("utf-8") in raw

def main():
    status, headers, raw = req("GET", "/admin/", allow_redirect=False, cookies=False)
    loc = headers.get("Location") or headers.get("location") or ""
    rec("未登录访问 /admin/ 被拒绝", status in (401, 302, 303) and "/admin/login.html" in loc, f"HTTP {status}, Location={loc}")

    status, headers, raw = req("GET", "/admin/finance", allow_redirect=False, cookies=False)
    loc = headers.get("Location") or headers.get("location") or ""
    rec("未登录访问 /admin/finance 被拒绝", status in (401, 302, 303) and "/admin/login.html" in loc, f"HTTP {status}, Location={loc}")

    status, headers, raw = req("GET", "/admin/login.html", cookies=False)
    html = raw.decode("utf-8", "replace")
    rec("登录页可打开且不含明文测试口令", status == 200 and PASSWORD not in html and "credentials.local.md" in html, f"HTTP {status}")

    status, body = api("login", {"jobId": "FS-ADV-001", "password": "wrong-password-xxxx"}, use_cookies=False)
    rec("错误口令被拒绝", status in (401, 403) and body.get("ok") is False, f"HTTP {status}, error={body.get('error')}")

    store = pkg / "data/store.json"
    backup = pkg / "data/store.json.bak_test"
    shutil.move(str(store), str(backup))
    try:
        status, body = api("login", {"jobId": "FS-ADV-001", "password": PASSWORD}, use_cookies=False)
        rec("授权表缺失时拒绝（不默认放行）", status in (403, 401) and body.get("code") == "AUTH_STORE_MISSING", f"HTTP {status}, code={body.get('code')}")
    finally:
        shutil.move(str(backup), str(store))

    status, body = api("login", {"jobId": "FS-ADV-001", "password": PASSWORD})
    rec("正确口令可登录", status == 200 and body.get("ok") and body["data"]["user"]["jobId"] == "FS-ADV-001", f"HTTP {status}")
    rec("登录后写入会话 cookie", any(c.name == "fs_session" for c in cj), "fs_session")

    status, headers, raw = req("GET", "/admin/", allow_redirect=False)
    rec("登录后可打开 /admin/", status == 200 and has(raw, "总览看板"), f"HTTP {status}")

    admin_js = (pkg / "site/admin/js/app.js").read_text() + (pkg / "site/admin/js/api.js").read_text() + (pkg / "site/admin/index.html").read_text() + html
    rec("页面源码与 store 正文无明文口令", PASSWORD not in admin_js and PASSWORD not in store.read_text(), "scanned")

    for act in ["me", "getDashboard", "getPlans", "getProposals", "getDocuments", "getContracts"]:
        status, body = api(act)
        rec(f"模块接口 {act}", status == 200 and body.get("ok"), f"HTTP {status}")

    status, body = api("addCashItem", {"yearMonth": "2026-10", "date": "2026-10-20", "desc": "超限测试采购（虚构）", "direction": "支出", "amount": 3000, "currency": "HKD", "counterparty": "测试供应商丙（虚构）"})
    rec("单笔超过 2000 港元的现金收支不得进入第一本明细账", status == 400 and body.get("code") == "CASH_LIMIT", f"HTTP {status}, {body.get('error')}")

    status, body = api("addCashItem", {"yearMonth": "2026-10", "date": "2026-10-18", "desc": "测试活动摊位收入（虚构）", "direction": "收入", "amount": 800, "currency": "HKD", "counterparty": "测试摊位主办方（虚构）", "fileId": "FL-SEED-04"})
    rec("合规现金收支可登记", status == 200 and body.get("ok"), f"HTTP {status}")

    api("addStatement", {"yearMonth": "2026-09", "accountId": "TEST-BANK-HKD-UNBAL", "accountName": "测试银行-故意不平（虚构）", "opening": 1000, "closing": 9999, "currency": "HKD", "lines": [{"date": "2026-09-10", "desc": "测试", "direction": "收入", "amount": 100, "counterparty": "测试", "waiverCategory": ""}]})
    status, body = api("generateLedger", {"yearMonth": "2026-09"})
    rec("月结单不平则拒绝生成明细账（不把未配平说成已配平）", status == 400 and body.get("code") == "UNBALANCED", f"HTTP {status}")

    status, body = api("addStatement", {
        "yearMonth": "2026-10", "accountId": "TEST-BANK-HKD", "accountName": "测试银行-港币往来（虚构）",
        "opening": 100000, "closing": 122325, "currency": "HKD", "fileId": "FL-SEED-01",
        "lines": [
            {"date": "2026-10-12", "desc": "测试咨询费-测试客户甲（虚构）", "direction": "收入", "amount": 50000, "counterparty": "测试客户甲（虚构）", "waiverCategory": ""},
            {"date": "2026-10-15", "desc": "银行存款利息", "direction": "收入", "amount": 25, "counterparty": "测试银行（虚构）", "waiverCategory": "银行利息"},
            {"date": "2026-10-25", "desc": "办公室租金（正常金额）", "direction": "支出", "amount": 8000, "counterparty": "测试房东（虚构）", "waiverCategory": "租金"},
            {"date": "2026-10-27", "desc": "办公用品-测试供应商乙（虚构）", "direction": "支出", "amount": 3200, "counterparty": "测试供应商乙（虚构）", "waiverCategory": ""},
            {"date": "2026-10-28", "desc": "十月工资（正常发放）", "direction": "支出", "amount": 15000, "counterparty": "员工（测试）", "waiverCategory": "工资"},
            {"date": "2026-10-28", "desc": "十月 MPF", "direction": "支出", "amount": 1500, "counterparty": "测试强积金计划（虚构）", "waiverCategory": "MPF"},
        ],
    })
    rec("登记 2026-10 月结单（银行侧应轧平）", status == 200 and body.get("data", {}).get("statement", {}).get("internalDiff") == 0, f"HTTP {status}")

    status, body = api("generateLedger", {"yearMonth": "2026-10"})
    lines = body.get("data", {}).get("lines") or []
    rec("提交后生成第一本明细账且银行侧核对一致", status == 200 and body["data"]["month"]["bankBalanced"] is True and len(lines) == 7, f"lines={len(lines)}")
    by_desc = {l["desc"]: l for l in lines}

    status, body = api("postFourStatements", {"yearMonth": "2026-10"})
    rec("未过完成页不得计入正式四套账", status == 400 and "完成页" in (body.get("error") or ""), f"HTTP {status}")

    consult = by_desc["测试咨询费-测试客户甲（虚构）"]
    status, body = api("attachVoucher", {"lineId": consult["id"], "fileId": "FL-SEED-02"})
    rec("咨询费明细认领已上传的首期银行凭证（不重传）", status == 200 and body["data"]["line"]["voucherStatus"] == "已附原件", f"HTTP {status}")
    cash = by_desc["测试活动摊位收入（虚构）"]
    api("attachVoucher", {"lineId": cash["id"], "fileId": "FL-SEED-04"})
    for desc in ["银行存款利息", "办公室租金（正常金额）", "十月工资（正常发放）", "十月 MPF"]:
        status, body = api("waiveOriginal", {"lineId": by_desc[desc]["id"]})
        rec(f"免原件：{desc}", status == 200 and body["data"]["line"]["voucherStatus"] == "免原件", f"HTTP {status}")

    office = by_desc["办公用品-测试供应商乙（虚构）"]
    status, body = api("waiveOriginal", {"lineId": office["id"]})
    rec("办公用品不得免原件", status == 400, f"HTTP {status}")
    status, body = api("markSuspense", {"lineId": office["id"]})
    rec("限期后缺原件的办公用品标为暂记往来", status == 200 and body["data"]["line"]["voucherStatus"] == "暂记往来", f"HTTP {status}")

    status, body = api("getMonth", {"yearMonth": "2026-10"})
    g = body["data"]["groups"]
    rec("完成页列出已附原件 / 免原件 / 暂记往来，且无未处理",
        len(g["已附原件"]) >= 1 and len(g["免原件"]) >= 1 and len(g["暂记往来"]) >= 1 and len(g["未处理"]) == 0,
        f"已附={len(g['已附原件'])}, 免={len(g['免原件'])}, 暂记={len(g['暂记往来'])}, 未处理={len(g['未处理'])}")

    status, body = api("confirmCompletion", {"yearMonth": "2026-10"})
    rec("确认完成页", status == 200 and body["data"]["month"]["completionConfirmed"] is True, f"HTTP {status}")
    status, body = api("postFourStatements", {"yearMonth": "2026-10"})
    rec("完成页确认后可定稿四套账且资产负债表配平", status == 200 and body["data"]["balanced"] is True and body["data"]["totals"]["balanceDiff"] == 0, body["data"]["summary"])

    status, body = api("generateOfficialContract", {"contractNo": "FS-TEST-C-001"})
    rec("对客正式合同生成入口关闭", status == 403 and body.get("code") == "GENERATION_CLOSED", f"HTTP {status}")
    status, body = api("enterExecution", {"contractNo": "FS-TEST-C-001"})
    rec("无首期凭证时不能进入执行（保持待收（付）首期）", status == 400 and "待收" in (body.get("error") or ""), f"HTTP {status}")

    status, body = api("claimFirstVoucher", {"contractNo": "FS-TEST-C-001", "fileId": "FL-SEED-02", "lineId": consult["id"]})
    c = (body.get("data") or {}).get("contract") or {}
    rec("认领同一份首期凭证后进入执行并生成履约计划", status == 200 and c.get("status") in ("执行中", "逾期") and len(c.get("plan") or []) >= 1, f"HTTP {status}, status={c.get('status')}, plan={len(c.get('plan') or [])}")

    status, body = api("closeContract", {"contractNo": "FS-TEST-C-001", "closeType": "状态二"})
    rec("无双方协议文件时不能标为状态二", status == 400 and "协议" in (body.get("error") or ""), f"HTTP {status}")
    status, body = api("closeContract", {"contractNo": "FS-TEST-C-001", "closeType": "状态三"})
    rec("无双方协议文件时不能标为状态三", status == 400 and "协议" in (body.get("error") or ""), f"HTTP {status}")

    status, body = api("getContracts")
    ct = next(x for x in body["data"]["contracts"] if x["contractNo"] == "FS-TEST-C-001")
    rec("执行中逾期节点使合同状态为逾期", ct.get("status") == "逾期" and ct.get("plan"), f"status={ct.get('status')}")

    store_obj = json.loads(store.read_text())
    f2 = next(f for f in store_obj["files"] if f["id"] == "FL-SEED-02")
    modules = {c.get("module") for c in f2.get("claimedBy") or []}
    consult_lines = [l for l in store_obj["ledger"] if "咨询费" in l["desc"] and l["yearMonth"] == "2026-10"]
    rec("同一测试文件被月账与合同认领，账上咨询费只记一次", "月账" in modules and "合同" in modules and len(consult_lines) == 1 and consult_lines[0]["amountHkd"] == 50000, f"modules={sorted(modules)}, hits={len(consult_lines)}")

    status, body = api("getDashboard")
    rec("跨月未完成两次以上预警出现在看板", any("测试市场推广跟进" in w.get("message", "") for w in body["data"]["warnings"]), "warnings present")
    status, body = api("acknowledgePics", {"version": "PICS-PREVIEW-v0.1"})
    rec("隐私声明存证可写入", status == 200 and body.get("ok"), f"HTTP {status}")
    status, headers, raw = req("GET", "/", cookies=False)
    rec("公开首页可在预览服务打开", status == 200 and has(raw, "FUNSTOCK"), f"HTTP {status}")
    status, headers, raw = req("GET", "/c/", cookies=False)
    rec("资料整理页 /c/ 仍在原路径", status == 200, f"HTTP {status}")
    admin_all = ""
    for p in (pkg / "site/admin").rglob("*"):
        if p.is_file() and p.suffix in {".html", ".js", ".css"}:
            admin_all += p.read_text(encoding="utf-8", errors="replace")
    rec("后台文案不含「续签」", "续签" not in admin_all, "scanned site/admin")

    text = json.dumps(results, ensure_ascii=False, indent=2)
    assert PASSWORD not in text
    (pkg / "data/test-run-results.json").write_text(text, encoding="utf-8")
    passed = sum(1 for r in results if r["passed"])
    print(f"\n==== {passed}/{len(results)} passed ====")
    for r in results:
        if not r["passed"]:
            print("FAIL:", r["name"], ":", r["evidence"])
    return 0 if passed == len(results) else 1

if __name__ == "__main__":
    raise SystemExit(main())
