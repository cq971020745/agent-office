# -*- coding: utf-8 -*-
"""
WPS V7 个人待办 API 封装。
接口文档: https://365.kdocs.cn/3rd/open/documents/app-integration-dev/wps365/server/todo/task/personal_todo/
"""
from typing import Optional, List, Dict, Any
from .base import WpsV7Client


def _list_personal_todos_simple(
    status: Optional[str] = None,
    page_size: int = 50,
    page_token: Optional[str] = None,
    due_time_start: Optional[int] = None,
    due_time_end: Optional[int] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    私网简易版：获取个人待办列表。
    POST /v7/todo/personal_tasks/batch_get_simple
    不支持 keyword/executor/created_time 过滤，返回字段精简。
    """
    c = client or WpsV7Client()
    body: Dict[str, Any] = {
        "page_size": min(500, page_size),
    }
    if status:
        body["status"] = status
    if page_token:
        body["page_token"] = page_token
    if due_time_start is not None or due_time_end is not None:
        body["due_time"] = {}
        if due_time_start is not None:
            body["due_time"]["start_time"] = due_time_start
        if due_time_end is not None:
            body["due_time"]["end_time"] = due_time_end
    return c.post("/v7/todo/personal_tasks/batch_get_simple", json=body)


def list_personal_todos(
    status: Optional[str] = None,
    page_size: int = 50,
    page_token: Optional[str] = None,
    executor: Optional[str] = None,
    keyword: Optional[str] = None,
    created_time_start: Optional[int] = None,
    created_time_end: Optional[int] = None,
    due_time_start: Optional[int] = None,
    due_time_end: Optional[int] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    获取个人待办列表。
    公网: POST /v7/todo/personal_tasks/batch_get
    私网: 降级为 _list_personal_todos_simple（不支持 keyword/executor/created_time 过滤）
    """
    c = client or WpsV7Client()

    if c.is_private:
        return _list_personal_todos_simple(
            status=status,
            page_size=page_size,
            page_token=page_token,
            due_time_start=due_time_start,
            due_time_end=due_time_end,
            client=c,
        )

    body: Dict[str, Any] = {
        "page_size": page_size,
    }
    if status:
        body["status"] = status
    if page_token:
        body["page_token"] = page_token
    if executor:
        body["executor"] = executor
    if keyword:
        body["keyword"] = keyword
    if created_time_start is not None or created_time_end is not None:
        body["created_time"] = {}
        if created_time_start is not None:
            body["created_time"]["start_time"] = created_time_start
        if created_time_end is not None:
            body["created_time"]["end_time"] = created_time_end
    if due_time_start is not None or due_time_end is not None:
        body["due_time"] = {}
        if due_time_start is not None:
            body["due_time"]["start_time"] = due_time_start
        if due_time_end is not None:
            body["due_time"]["end_time"] = due_time_end

    return c.post("/v7/todo/personal_tasks/batch_get", json=body)


def get_personal_todo(task_id: str, client: Optional[WpsV7Client] = None) -> dict:
    """
    获取个人待办详情。
    GET /v7/todo/personal_tasks/{task_id}

    Args:
        task_id: 待办 ID
        client: WpsV7Client 实例，默认自动创建
    """
    c = client or WpsV7Client()
    return c.get(f"/v7/todo/personal_tasks/{task_id}")


def create_personal_todo(
    title: str,
    description: Optional[str] = None,
    due_time: Optional[int] = None,
    status: str = "todo",
    biz_source: str = "openclaw",
    executors: Optional[List[str]] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    创建个人待办。
    POST /v7/todo/personal_tasks

    Args:
        title: 待办标题
        description: 待办描述
        due_time: 截止时间（毫秒时间戳）
        status: 状态 (todo/finish)，默认 todo
        biz_source: 待办来源，默认 openclaw
        executors: 执行人 ID 列表
        client: WpsV7Client 实例，默认自动创建
    """
    c = client or WpsV7Client()
    body: Dict[str, Any] = {
        "biz_source": biz_source,
        "title": {
            "subject": title,
        },
        "status": status,
    }
    if description is not None:
        body["description"] = description
    if due_time is not None:
        body["due_time"] = due_time
    if executors is not None:
        body["executors"] = executors

    return c.post("/v7/todo/personal_tasks", json=body)


def update_personal_todo(
    task_id: str,
    title: Optional[str] = None,
    description: Optional[str] = None,
    due_time: Optional[int] = None,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    更新个人待办（标题、描述、截止时间）。
    POST /v7/todo/personal_tasks/{task_id}/update

    注意：状态更新请使用 update_personal_todo_status。

    Args:
        task_id: 待办 ID
        title: 新标题
        description: 新描述
        due_time: 新截止时间（毫秒时间戳）
        client: WpsV7Client 实例，默认自动创建
    """
    c = client or WpsV7Client()
    body: Dict[str, Any] = {}
    if title is not None:
        body["title"] = {"subject": title}
    if description is not None:
        body["description"] = description
    if due_time is not None:
        body["due_time"] = due_time

    return c.post(f"/v7/todo/personal_tasks/{task_id}/update", json=body)


def update_personal_todo_status(
    task_id: str,
    action: str,
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    更新个人待办状态。
    POST /v7/todo/personal_tasks/{task_id}/update_status

    Args:
        task_id: 待办 ID
        action: 目标状态动作 (finish/unfinish)
        client: WpsV7Client 实例，默认自动创建
    """
    c = client or WpsV7Client()
    return c.post(f"/v7/todo/personal_tasks/{task_id}/update_status", json={"action": action})


def delete_personal_todos(
    task_ids: List[str],
    client: Optional[WpsV7Client] = None,
) -> dict:
    """
    批量删除个人待办。
    POST /v7/todo/personal_tasks/batch_delete

    Args:
        task_ids: 待办 ID 列表
        client: WpsV7Client 实例，默认自动创建
    """
    c = client or WpsV7Client()
    return c.post("/v7/todo/personal_tasks/batch_delete", json={"ids": task_ids})
