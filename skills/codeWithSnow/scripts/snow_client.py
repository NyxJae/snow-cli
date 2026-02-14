#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Snow CLI SSE Python 客户端.

该脚本在 simple 版本基础上扩展为全量 CLI 能力,覆盖:
- chat/confirm/reject/answer/abort/switch-agent.
- 会话管理(list/load/delete),代理列表,回滚点查询与回滚执行.
- 健康检查,图片输入,中文输入输出,结构化 JSON 输出.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set
from urllib import error, parse, request


def configure_stdio_utf8() -> None:
    """配置标准输出为 UTF-8,确保中文显示正常."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


@dataclass
class ClientResult:
    """客户端统一输出结构.

    该结构兼容聊天类输出,并支持会话管理/回滚/健康检查等扩展字段.
    """

    status: str
    session_id: Optional[str] = None
    messages: List[Dict[str, Any]] = field(default_factory=list)
    usage: Dict[str, Any] = field(default_factory=dict)
    error_code: Optional[str] = None
    message: Optional[str] = None
    suggestion: Optional[str] = None
    request_id: Optional[str] = None
    request_data: Optional[Dict[str, Any]] = None
    sessions: Optional[List[Dict[str, Any]]] = None
    total: Optional[int] = None
    agents: Optional[List[Dict[str, Any]]] = None
    current_agent_id: Optional[str] = None
    available_agents: Optional[List[Dict[str, Any]]] = None
    rollback_points: Optional[List[Dict[str, Any]]] = None
    deleted: Optional[bool] = None
    health: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        """转为可 JSON 序列化字典."""
        data: Dict[str, Any] = {
            "status": self.status,
            "session_id": self.session_id,
            "messages": self.messages,
            "usage": self.usage,
        }

        if self.error_code:
            data["error_code"] = self.error_code
        if self.message:
            data["message"] = self.message
        if self.suggestion:
            data["suggestion"] = self.suggestion
        if self.request_id:
            data["request_id"] = self.request_id

        if self.request_data:
            data["request_data"] = self.request_data
            if self.status == "requires_confirmation":
                tool_call = (
                    self.request_data.get("tool_call")
                    or self.request_data.get("toolCall")
                    or self.request_data.get("tool")
                )
                available_options = (
                    self.request_data.get("available_options")
                    or self.request_data.get("availableOptions")
                )
                if tool_call:
                    data["tool_call"] = tool_call
                if available_options:
                    data["available_options"] = available_options
                data.setdefault("message", "需要确认工具执行")
            elif self.status == "requires_question":
                question = self.request_data.get("question")
                options = self.request_data.get("options")
                multi_select = self.request_data.get("multi_select")
                if multi_select is None:
                    multi_select = self.request_data.get("multiSelect")
                if question:
                    data["question"] = question
                if options is not None:
                    data["options"] = options
                if multi_select is not None:
                    data["multi_select"] = bool(multi_select)
                data.setdefault("message", "AI 需要您回答一个问题")

        if self.sessions is not None:
            data["sessions"] = self.sessions
        if self.total is not None:
            data["total"] = self.total
        if self.agents is not None:
            data["agents"] = self.agents
        if self.current_agent_id is not None:
            data["current_agent_id"] = self.current_agent_id
        if self.available_agents is not None:
            data["available_agents"] = self.available_agents
        if self.rollback_points is not None:
            data["rollback_points"] = self.rollback_points
        if self.deleted is not None:
            data["deleted"] = self.deleted
        if self.health is not None:
            data["health"] = self.health

        return data


class SimpleSnowSSEClient:
    """Snow SSE 客户端.

    该类负责:
    - 建立 SSE 连接并处理事件.
    - 调用 HTTP API 完成消息/会话/回滚等操作.
    - 统一输出 ClientResult,便于外部 AI 解析.
    """

    def __init__(
        self,
        host: str,
        port: int,
        connect_timeout: float,
        request_timeout: float,
        verbose: bool = False,
    ) -> None:
        """初始化客户端配置."""
        self._host = host
        self._port = port
        self._base_url = f"http://{host}:{port}"
        self._connect_timeout = connect_timeout
        self._request_timeout = request_timeout
        self._verbose = verbose

        self._lock = threading.RLock()
        self._connected_event = threading.Event()
        self._completed_event = threading.Event()
        self._stream_response = None
        self._stream_sock: Optional[socket.socket] = None
        self._reader_thread: Optional[threading.Thread] = None

        self._completion_events: Set[str] = set()
        self._connection_id: Optional[str] = None
        self._session_id: Optional[str] = None
        self._messages: List[Dict[str, Any]] = []
        self._assistant_final_content = ""
        self._assistant_stream_content = ""

        self._usage: Dict[str, Any] = {}
        self._error: Optional[Dict[str, Any]] = None
        self._pending_request: Optional[Dict[str, Any]] = None
        self._final_event: Optional[Dict[str, Any]] = None
        self._agent_list_data: Optional[Dict[str, Any]] = None
        self._agent_switched_data: Optional[Dict[str, Any]] = None
        self._rollback_result_data: Optional[Dict[str, Any]] = None
        self._outbound_image_names: List[str] = []

    def send_chat(
        self,
        content: str,
        session_id: Optional[str],
        images: Optional[List[str]] = None,
        yolo_mode: bool = True,
    ) -> ClientResult:
        """发送 chat 请求并等待 complete 或交互事件."""
        payload: Dict[str, Any] = {
            "type": "chat",
            "content": content,
            "yoloMode": bool(yolo_mode),
        }
        image_names: List[str] = []
        if images:
            try:
                payload["images"] = self._build_images_payload(images)
                image_names = [os.path.basename(path) for path in images if path]
            except (FileNotFoundError, ValueError) as exc:
                return ClientResult(
                    status="error",
                    session_id=session_id,
                    error_code="invalid_args",
                    message=str(exc),
                )

        return self._run_message_operation(
            payload=payload,
            session_id=session_id,
            completion_events={
                "complete",
                "tool_confirmation_request",
                "user_question_request",
                "error",
            },
            ensure_session_if_missing=True,
            outbound_image_names=image_names,
        )

    def send_tool_confirmation(
        self,
        session_id: str,
        request_id: str,
        approve: bool,
    ) -> ClientResult:
        """发送工具确认响应.

        当 approve 为 True 时发送 approve.
        当 approve 为 False 时发送 reject.
        """
        payload: Dict[str, Any] = {
            "type": "tool_confirmation_response",
            "requestId": request_id,
            "response": "approve" if approve else "reject",
        }
        return self._run_message_operation(
            payload=payload,
            session_id=session_id,
            completion_events={
                "complete",
                "tool_confirmation_request",
                "user_question_request",
                "error",
            },
            ensure_session_if_missing=False,
            wait_sse_completion=False,
        )

    def send_question_answer(
        self,
        session_id: str,
        request_id: str,
        answer_text: str,
    ) -> ClientResult:
        """发送 user_question_response 响应."""
        payload: Dict[str, Any] = {
            "type": "user_question_response",
            "requestId": request_id,
            "response": answer_text,
        }
        return self._run_message_operation(
            payload=payload,
            session_id=session_id,
            completion_events={
                "complete",
                "tool_confirmation_request",
                "user_question_request",
                "error",
            },
            ensure_session_if_missing=False,
            wait_sse_completion=False,
        )

    def abort_task(self, session_id: str) -> ClientResult:
        """发送 abort 请求.

        abort 通常返回 HTTP success,并异步推送提示消息.
        这里按协议返回同步成功结果.
        """
        payload: Dict[str, Any] = {"type": "abort", "sessionId": session_id}
        try:
            post_result = self._post_json("/message", payload, timeout=self._request_timeout)
            if not post_result.get("success"):
                raise RuntimeError(f"发送中断请求失败: {post_result}")
            return ClientResult(
                status="success",
                session_id=session_id,
                message="任务已中断",
            )
        except error.URLError as exc:
            return self._connection_failed_result(exc)
        except Exception as exc:  # pylint: disable=broad-except
            return ClientResult(
                status="error",
                session_id=session_id,
                error_code="unexpected_error",
                message=str(exc),
            )

    def switch_agent(self, agent_id: str, session_id: Optional[str]) -> ClientResult:
        """切换会话主代理."""
        payload: Dict[str, Any] = {"type": "switch_agent", "agentId": agent_id}
        return self._run_message_operation(
            payload=payload,
            session_id=session_id,
            completion_events={"agent_switched", "error"},
            ensure_session_if_missing=True,
        )

    def list_agents(self, session_id: Optional[str]) -> ClientResult:
        """获取可用主代理列表.

        说明:
        - 协议没有独立 /agents 端点.
        - 当前通过无效 switch_agent 触发 error.availableAgents 作为回退获取列表.
        """
        probe_payload: Dict[str, Any] = {
            "type": "switch_agent",
            "agentId": "__agent_probe_not_exists__",
        }
        raw = self._run_message_operation(
            payload=probe_payload,
            session_id=session_id,
            completion_events={"agent_list", "error"},
            ensure_session_if_missing=True,
        )

        if raw.status == "success" and raw.agents is not None:
            return raw

        if raw.available_agents is not None:
            return ClientResult(
                status="success",
                session_id=raw.session_id,
                agents=raw.available_agents,
                current_agent_id=raw.current_agent_id,
            )

        return raw

    def list_sessions(
        self,
        page: int = 0,
        page_size: int = 20,
        search_query: Optional[str] = None,
    ) -> ClientResult:
        """列出会话列表."""
        query: Dict[str, Any] = {"page": page, "pageSize": page_size}
        if search_query:
            query["q"] = search_query

        try:
            response = self._get_json("/session/list", query=query, timeout=self._request_timeout)
            if not response.get("success"):
                raise RuntimeError(f"获取会话列表失败: {response}")

            sessions_raw = response.get("sessions")
            sessions = [
                self._normalize_session_item(item)
                for item in sessions_raw
                if isinstance(item, dict)
            ] if isinstance(sessions_raw, list) else []

            return ClientResult(
                status="success",
                sessions=sessions,
                total=int(response.get("total", len(sessions))),
            )
        except error.URLError as exc:
            return self._connection_failed_result(exc)
        except Exception as exc:  # pylint: disable=broad-except
            return ClientResult(
                status="error",
                error_code="unexpected_error",
                message=str(exc),
            )

    def load_session(self, session_id: str) -> ClientResult:
        """加载会话."""
        try:
            response = self._post_json(
                "/session/load",
                {"sessionId": session_id},
                timeout=self._request_timeout,
            )
            if not response.get("success"):
                raise RuntimeError(f"加载会话失败: {response}")
            session = response.get("session")
            return ClientResult(
                status="success",
                session_id=(session or {}).get("id", session_id)
                if isinstance(session, dict)
                else session_id,
                message="会话加载成功",
            )
        except error.HTTPError as exc:
            return self._http_error_to_result(exc)
        except error.URLError as exc:
            return self._connection_failed_result(exc)
        except Exception as exc:  # pylint: disable=broad-except
            return ClientResult(
                status="error",
                session_id=session_id,
                error_code="unexpected_error",
                message=str(exc),
            )

    def delete_session(self, session_id: str) -> ClientResult:
        """删除会话."""
        try:
            response = self._delete_json(f"/session/{parse.quote(session_id)}")
            if not response.get("success"):
                raise RuntimeError(f"删除会话失败: {response}")
            return ClientResult(
                status="success",
                session_id=session_id,
                deleted=bool(response.get("deleted")),
                message="会话删除完成",
            )
        except error.HTTPError as exc:
            return self._http_error_to_result(exc)
        except error.URLError as exc:
            return self._connection_failed_result(exc)
        except Exception as exc:  # pylint: disable=broad-except
            return ClientResult(
                status="error",
                session_id=session_id,
                error_code="unexpected_error",
                message=str(exc),
            )

    def list_rollback_points(self, session_id: str) -> ClientResult:
        """列出会话可用回滚点."""
        try:
            response = self._get_json(
                "/session/rollback-points",
                query={"sessionId": session_id},
                timeout=self._request_timeout,
            )
            if not response.get("success"):
                raise RuntimeError(f"获取回滚点失败: {response}")
            points = response.get("points")
            normalized_points = points if isinstance(points, list) else []
            return ClientResult(
                status="success",
                session_id=session_id,
                rollback_points=normalized_points,
                total=len(normalized_points),
            )
        except error.HTTPError as exc:
            return self._http_error_to_result(exc)
        except error.URLError as exc:
            return self._connection_failed_result(exc)
        except Exception as exc:  # pylint: disable=broad-except
            return ClientResult(
                status="error",
                session_id=session_id,
                error_code="unexpected_error",
                message=str(exc),
            )

    def rollback_to(
        self,
        session_id: str,
        message_index: int,
        rollback_files: bool,
        selected_files: Optional[List[str]] = None,
    ) -> ClientResult:
        """执行会话回滚."""
        rollback_payload: Dict[str, Any] = {
            "messageIndex": message_index,
            "rollbackFiles": bool(rollback_files),
        }
        if selected_files:
            rollback_payload["selectedFiles"] = selected_files

        payload: Dict[str, Any] = {
            "type": "rollback",
            "rollback": rollback_payload,
        }
        return self._run_message_operation(
            payload=payload,
            session_id=session_id,
            completion_events={"rollback_result", "error"},
            ensure_session_if_missing=False,
        )

    def health_check(self) -> ClientResult:
        """执行健康检查."""
        try:
            response = self._get_json("/health", timeout=self._connect_timeout)
            return ClientResult(status="success", health=response)
        except error.URLError as exc:
            return self._connection_failed_result(exc)
        except Exception as exc:  # pylint: disable=broad-except
            return ClientResult(
                status="error",
                error_code="unexpected_error",
                message=str(exc),
            )

    def _run_message_operation(
        self,
        payload: Dict[str, Any],
        session_id: Optional[str],
        completion_events: Set[str],
        ensure_session_if_missing: bool,
        outbound_image_names: Optional[List[str]] = None,
        wait_sse_completion: bool = True,
    ) -> ClientResult:
        """执行需要 SSE 事件回传的 message 操作."""
        self._reset_runtime_state(
            session_id=session_id,
            completion_events=completion_events,
            outbound_image_names=outbound_image_names,
        )
        self._log(
            f"开始 message 操作,type={payload.get('type')},session_id={session_id},completion_events={sorted(completion_events)}"
        )

        try:
            self._open_event_stream()
            reader = threading.Thread(target=self._event_reader_loop, daemon=True)
            self._reader_thread = reader
            reader.start()

            if not self._connected_event.wait(timeout=self._connect_timeout):
                raise TimeoutError("连接 SSE 事件流超时")
            self._log(f"SSE 已连接,connection_id={self._connection_id}")

            effective_session_id = session_id
            if effective_session_id:
                payload["sessionId"] = effective_session_id
                self._bind_session_to_connection(effective_session_id)
            elif ensure_session_if_missing:
                effective_session_id = self._ensure_session_for_connection()
                if effective_session_id:
                    payload["sessionId"] = effective_session_id
                else:
                    self._log("自动创建会话失败,将继续以无 sessionId 发送 /message")

            self._log(
                f"发送 /message,payload.type={payload.get('type')},sessionId={payload.get('sessionId')}"
            )

            post_done = threading.Event()
            post_result_box: Dict[str, Any] = {}
            post_error_box: List[Exception] = []

            def _post_message() -> None:
                try:
                    post_result_box["result"] = self._post_json(
                        "/message",
                        payload,
                        timeout=self._request_timeout,
                    )
                except Exception as exc:  # pylint: disable=broad-except
                    post_error_box.append(exc)
                finally:
                    post_done.set()

            post_thread = threading.Thread(target=_post_message, daemon=True)
            post_thread.start()

            deadline = time.monotonic() + self._request_timeout
            post_response_checked = False

            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("等待 SSE 响应完成超时")

                if wait_sse_completion and self._completed_event.wait(
                    timeout=min(0.05, remaining)
                ):
                    break

                if post_done.is_set() and not post_response_checked:
                    post_response_checked = True
                    if post_error_box:
                        raise post_error_box[0]
                    post_result = post_result_box.get("result")
                    self._log(f"/message 响应: {post_result}")
                    if isinstance(post_result, dict) and not post_result.get("success"):
                        raise RuntimeError(f"发送消息失败: {post_result}")
                    if not wait_sse_completion:
                        break

            if post_done.is_set() and not post_response_checked:
                post_response_checked = True
                if post_error_box:
                    raise post_error_box[0]
                post_result = post_result_box.get("result")
                self._log(f"/message 响应: {post_result}")
                if isinstance(post_result, dict) and not post_result.get("success"):
                    raise RuntimeError(f"发送消息失败: {post_result}")
            elif wait_sse_completion and not post_done.is_set():
                self._log("/message 请求仍在等待,已基于 SSE 终止事件提前返回")

            self._log(f"message 操作结束,final_event={self._final_event}")
            return self._build_result()
        except TimeoutError as exc:
            return ClientResult(
                status="error",
                session_id=self._session_id,
                error_code="timeout",
                message=str(exc),
            )
        except error.HTTPError as exc:
            return self._http_error_to_result(exc)
        except error.URLError as exc:
            return self._connection_failed_result(exc)
        except Exception as exc:  # pylint: disable=broad-except
            return ClientResult(
                status="error",
                session_id=self._session_id,
                error_code="unexpected_error",
                message=str(exc),
            )
        finally:
            self._close_event_stream()

    def _reset_runtime_state(
        self,
        session_id: Optional[str],
        completion_events: Set[str],
        outbound_image_names: Optional[List[str]] = None,
    ) -> None:
        """重置单次请求中的运行态数据."""
        self._connected_event.clear()
        self._completed_event.clear()
        self._completion_events = set(completion_events)

        self._connection_id = None
        self._session_id = session_id
        self._messages = []
        self._assistant_final_content = ""
        self._assistant_stream_content = ""
        self._usage = {}
        self._error = None
        self._pending_request = None
        self._final_event = None
        self._agent_list_data = None
        self._agent_switched_data = None
        self._rollback_result_data = None
        self._outbound_image_names = list(outbound_image_names or [])
        self._stream_sock = None
        self._reader_thread = None

    def _open_event_stream(self) -> None:
        """建立 SSE 事件流连接.

        仅用 connect_timeout 限制建链阶段,随后清除 socket 读取超时,
        避免长对话期间因暂时无数据而触发 timed out.
        """
        req = request.Request(
            f"{self._base_url}/events",
            method="GET",
            headers={"Accept": "text/event-stream"},
        )
        self._stream_response = request.urlopen(req, timeout=self._connect_timeout)
        self._stream_sock = None
        if hasattr(self._stream_response, "fp") and hasattr(self._stream_response.fp, "raw"):
            sock = getattr(self._stream_response.fp.raw, "_sock", None)
            if isinstance(sock, socket.socket):
                sock.settimeout(None)
                self._stream_sock = sock
        self._log("SSE 事件流已连接")

    def _close_event_stream(self) -> None:
        """关闭 SSE 流连接并尽快结束 reader 线程."""
        with self._lock:
            stream_response = self._stream_response
            stream_sock = self._stream_sock
            reader_thread = self._reader_thread
            self._stream_response = None
            self._stream_sock = None
            self._reader_thread = None

        self._completed_event.set()

        if stream_sock is not None:
            try:
                stream_sock.close()
            except Exception:  # pylint: disable=broad-except
                pass

        if (
            reader_thread is not None
            and reader_thread.is_alive()
            and reader_thread is not threading.current_thread()
        ):
            reader_thread.join(timeout=1.0)
            if reader_thread.is_alive():
                self._log("SSE reader 线程未在超时内退出")

        if stream_response is not None:
            close_done = threading.Event()

            def _close_response() -> None:
                try:
                    stream_response.close()
                except Exception:  # pylint: disable=broad-except
                    pass
                finally:
                    close_done.set()

            closer = threading.Thread(target=_close_response, daemon=True)
            closer.start()
            close_done.wait(timeout=0.5)
            if not close_done.is_set():
                self._log("SSE response.close 超时,已异步释放")

        if stream_response is not None or stream_sock is not None:
            self._log("SSE 事件流已关闭")

    def _post_json(
        self,
        path: str,
        payload: Dict[str, Any],
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """发送 JSON POST 请求."""
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = request.Request(
            f"{self._base_url}{path}",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        effective_timeout = timeout if timeout is not None else self._connect_timeout
        with request.urlopen(req, timeout=effective_timeout) as resp:
            status_code = getattr(resp, "status", resp.getcode())
            raw = resp.read().decode("utf-8", errors="replace")

        if not raw:
            return {}

        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"服务响应不是有效 JSON,status={status_code},body={raw[:200]}"
            ) from exc

    def _get_json(
        self,
        path: str,
        query: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """发送 JSON GET 请求."""
        encoded_query = ""
        if query:
            pairs = [
                (key, str(value))
                for key, value in query.items()
                if value is not None and value != ""
            ]
            if pairs:
                encoded_query = f"?{parse.urlencode(pairs)}"

        req = request.Request(
            f"{self._base_url}{path}{encoded_query}",
            method="GET",
            headers={"Accept": "application/json"},
        )
        effective_timeout = timeout if timeout is not None else self._connect_timeout
        with request.urlopen(req, timeout=effective_timeout) as resp:
            status_code = getattr(resp, "status", resp.getcode())
            raw = resp.read().decode("utf-8", errors="replace")

        if not raw:
            return {}

        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"服务响应不是有效 JSON,status={status_code},body={raw[:200]}"
            ) from exc

    def _delete_json(self, path: str, timeout: Optional[float] = None) -> Dict[str, Any]:
        """发送 JSON DELETE 请求."""
        req = request.Request(
            f"{self._base_url}{path}",
            method="DELETE",
            headers={"Accept": "application/json"},
        )
        effective_timeout = timeout if timeout is not None else self._connect_timeout
        with request.urlopen(req, timeout=effective_timeout) as resp:
            status_code = getattr(resp, "status", resp.getcode())
            raw = resp.read().decode("utf-8", errors="replace")

        if not raw:
            return {}

        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"服务响应不是有效 JSON,status={status_code},body={raw[:200]}"
            ) from exc

    def _bind_session_to_connection(self, session_id: str) -> None:
        """把已有会话绑定到当前 SSE 连接,避免事件被路由到旧连接."""
        if not self._connection_id or not session_id:
            return

        try:
            response = self._post_json(
                "/session/load",
                {
                    "sessionId": session_id,
                    "connectionId": self._connection_id,
                },
                timeout=self._connect_timeout,
            )
        except Exception as exc:  # pylint: disable=broad-except
            self._log(f"重绑会话到当前连接失败: {exc}")
            return

        if not response.get("success"):
            self._log(f"重绑会话到当前连接未成功: {response}")
            return

        session = response.get("session")
        if isinstance(session, dict) and session.get("id"):
            self._session_id = str(session["id"])

    def _ensure_session_for_connection(self) -> Optional[str]:
        """根据 connectionId 预创建会话,避免多连接场景消息路由歧义."""
        if not self._connection_id:
            return None

        try:
            response = self._post_json(
                "/session/create",
                {"connectionId": self._connection_id},
                timeout=self._connect_timeout,
            )
        except Exception as exc:  # pylint: disable=broad-except
            self._log(f"自动创建会话失败: {exc}")
            return None

        if not response.get("success"):
            self._log(f"自动创建会话未成功: {response}")
            return None

        session = response.get("session")
        if isinstance(session, dict) and session.get("id"):
            self._session_id = str(session["id"])
            return self._session_id

        self._log(f"自动创建会话返回缺少 session.id: {response}")
        return None

    def _event_reader_loop(self) -> None:
        """持续读取并解析 SSE 事件流."""
        if self._stream_response is None:
            return

        data_lines: List[str] = []
        try:
            for raw_line in self._stream_response:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")

                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
                    continue

                if line == "":
                    if data_lines:
                        self._handle_data_block("\n".join(data_lines))
                        data_lines = []
                    if self._completed_event.is_set():
                        break
        except Exception as exc:  # pylint: disable=broad-except
            if not self._completed_event.is_set():
                with self._lock:
                    self._error = {
                        "error_code": "event_stream_error",
                        "message": f"读取 SSE 事件失败: {exc}",
                    }
                self._completed_event.set()

    def _handle_data_block(self, data_text: str) -> None:
        """处理单个 SSE data 块."""
        try:
            event = json.loads(data_text)
        except json.JSONDecodeError:
            self._log(f"忽略无法解析的事件: {data_text}")
            return

        event_type = event.get("type")
        data = event.get("data") if isinstance(event.get("data"), dict) else (event.get("data") or {})
        request_id = event.get("requestId")

        self._log(f"收到事件: {event_type}")

        if event_type == "connected":
            connection_id = data.get("connectionId") if isinstance(data, dict) else None
            with self._lock:
                if connection_id:
                    self._connection_id = str(connection_id)
            self._connected_event.set()
            return

        if event_type == "message" and isinstance(data, dict):
            role = data.get("role")
            raw_content = data.get("content")
            content = "" if raw_content is None else str(raw_content)

            with self._lock:
                if role == "system" and data.get("sessionId"):
                    self._session_id = str(data["sessionId"])
                    return

                if role == "user" and content:
                    user_message: Dict[str, Any] = {"role": "user", "content": content}
                    if self._outbound_image_names:
                        user_message["images"] = list(self._outbound_image_names)
                    self._messages.append(user_message)
                    return

                if role == "assistant":
                    if bool(data.get("streaming")):
                        self._assistant_stream_content = content
                    else:
                        self._assistant_final_content = content
                    return

        if event_type == "usage" and isinstance(data, dict):
            with self._lock:
                self._usage = data
            return

        if event_type == "tool_confirmation_request" and isinstance(data, dict):
            with self._lock:
                self._pending_request = {
                    "status": "requires_confirmation",
                    "request_id": request_id,
                    "request_data": data,
                }
            self._mark_complete_if_needed(event_type, data, request_id)
            return

        if event_type == "user_question_request" and isinstance(data, dict):
            with self._lock:
                self._pending_request = {
                    "status": "requires_question",
                    "request_id": request_id,
                    "request_data": data,
                }
            self._mark_complete_if_needed(event_type, data, request_id)
            return

        if event_type == "agent_list" and isinstance(data, dict):
            with self._lock:
                self._agent_list_data = data
                agents = data.get("agents")
                if isinstance(agents, list):
                    self._pending_request = None
            self._mark_complete_if_needed(event_type, data, request_id)
            return

        if event_type == "agent_switched" and isinstance(data, dict):
            with self._lock:
                self._agent_switched_data = data
            self._mark_complete_if_needed(event_type, data, request_id)
            return

        if event_type == "rollback_result" and isinstance(data, dict):
            with self._lock:
                self._rollback_result_data = data
            self._mark_complete_if_needed(event_type, data, request_id)
            return

        if event_type == "error":
            error_message = data.get("message") if isinstance(data, dict) else str(data)
            error_code = data.get("errorCode") if isinstance(data, dict) else None
            available_agents = data.get("availableAgents") if isinstance(data, dict) else None
            with self._lock:
                self._error = {
                    "error_code": error_code or "server_error",
                    "message": error_message or "SSE 服务返回错误",
                }
                if isinstance(available_agents, list):
                    self._error["available_agents"] = available_agents
            self._mark_complete_if_needed(event_type, data if isinstance(data, dict) else {}, request_id)
            return

        if event_type == "complete" and isinstance(data, dict):
            with self._lock:
                if data.get("sessionId"):
                    self._session_id = str(data["sessionId"])
                if isinstance(data.get("usage"), dict):
                    self._usage = data["usage"]
            self._mark_complete_if_needed(event_type, data, request_id)

    def _mark_complete_if_needed(
        self,
        event_type: str,
        data: Dict[str, Any],
        request_id: Optional[str],
    ) -> None:
        """在目标事件出现时结束等待."""
        if event_type not in self._completion_events:
            return

        with self._lock:
            self._final_event = {
                "type": event_type,
                "data": data,
                "request_id": request_id,
            }
            self._completed_event.set()

    def _build_result(self) -> ClientResult:
        """根据当前运行态构建最终结果."""
        with self._lock:
            if self._pending_request:
                return ClientResult(
                    status=self._pending_request["status"],
                    session_id=self._session_id,
                    messages=list(self._messages),
                    usage=dict(self._usage),
                    request_id=self._pending_request.get("request_id"),
                    request_data=self._pending_request.get("request_data"),
                )

            if self._error:
                return ClientResult(
                    status="error",
                    session_id=self._session_id,
                    messages=list(self._messages),
                    usage=dict(self._usage),
                    error_code=self._error.get("error_code"),
                    message=self._error.get("message"),
                    available_agents=self._error.get("available_agents"),
                )

            if (
                isinstance(self._final_event, dict)
                and self._final_event.get("type") == "agent_list"
                and self._agent_list_data is not None
            ):
                agents = self._agent_list_data.get("agents")
                current_agent_id = self._agent_list_data.get("currentAgentId")
                return ClientResult(
                    status="success",
                    session_id=self._session_id,
                    agents=agents if isinstance(agents, list) else [],
                    current_agent_id=str(current_agent_id)
                    if current_agent_id is not None
                    else None,
                )

            if (
                isinstance(self._final_event, dict)
                and self._final_event.get("type") == "agent_switched"
                and self._agent_switched_data is not None
            ):
                current_agent_id = self._agent_switched_data.get("currentAgentId")
                agent_name = self._agent_switched_data.get("agentName")
                return ClientResult(
                    status="success",
                    session_id=self._session_id,
                    current_agent_id=str(current_agent_id)
                    if current_agent_id is not None
                    else None,
                    message=(
                        f"主代理已切换为 {agent_name}"
                        if agent_name
                        else "主代理切换成功"
                    ),
                )

            if (
                isinstance(self._final_event, dict)
                and self._final_event.get("type") == "rollback_result"
                and self._rollback_result_data is not None
            ):
                rollback_success = bool(self._rollback_result_data.get("success"))
                if rollback_success:
                    return ClientResult(
                        status="success",
                        session_id=str(
                            self._rollback_result_data.get("sessionId") or self._session_id
                        ),
                        request_data=self._rollback_result_data,
                        message="回滚执行成功",
                    )
                return ClientResult(
                    status="error",
                    session_id=str(
                        self._rollback_result_data.get("sessionId") or self._session_id
                    ),
                    error_code="rollback_failed",
                    message=str(self._rollback_result_data.get("error") or "回滚执行失败"),
                    request_data=self._rollback_result_data,
                )

            assistant_content = (
                self._assistant_final_content or self._assistant_stream_content
            )
            merged_messages = list(self._messages)
            if assistant_content:
                merged_messages.append(
                    {"role": "assistant", "content": assistant_content}
                )

            return ClientResult(
                status="success",
                session_id=self._session_id,
                messages=merged_messages,
                usage=dict(self._usage),
            )

    def _normalize_session_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """把服务端 SessionListItem 映射为更稳定的输出字段."""
        first_message = item.get("summary") or item.get("title")
        return {
            "id": item.get("id"),
            "created_at": self._format_timestamp(item.get("createdAt")),
            "updated_at": self._format_timestamp(item.get("updatedAt")),
            "message_count": item.get("messageCount", 0),
            "first_message": first_message,
            "project_path": item.get("projectPath"),
            "project_id": item.get("projectId"),
        }

    def _build_images_payload(self, image_paths: Iterable[str]) -> List[Dict[str, str]]:
        """把本地图片路径转为服务端要求的 base64 data URI 格式."""
        images: List[Dict[str, str]] = []
        for path in image_paths:
            if not path:
                continue
            parsed = parse.urlparse(path)
            if parsed.scheme in {"http", "https"}:
                raise ValueError(f"暂不支持 URL 图片,请使用本地文件路径: {path}")
            if not os.path.exists(path):
                raise FileNotFoundError(f"图片文件不存在: {path}")
            with open(path, "rb") as fp:
                raw = fp.read()
            mime_type = self._guess_mime_type(path)
            encoded = base64.b64encode(raw).decode("utf-8")
            images.append(
                {
                    "data": f"data:{mime_type};base64,{encoded}",
                    "mimeType": mime_type,
                }
            )
        return images

    @staticmethod
    def _guess_mime_type(file_path: str) -> str:
        """根据文件名推断 MIME 类型."""
        guessed, _ = mimetypes.guess_type(file_path)
        return guessed or "application/octet-stream"

    @staticmethod
    def _format_timestamp(raw_value: Any) -> Optional[str]:
        """把毫秒时间戳转为 ISO 8601 字符串."""
        if raw_value is None:
            return None
        try:
            ts = int(raw_value)
            dt = datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc)
            return dt.isoformat().replace("+00:00", "Z")
        except (TypeError, ValueError, OSError):
            return str(raw_value)

    def _http_error_to_result(self, exc: error.HTTPError) -> ClientResult:
        """把 HTTPError 统一转换为结构化错误输出."""
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")
        except Exception:  # pylint: disable=broad-except
            body = ""

        parsed_body: Dict[str, Any] = {}
        if body:
            try:
                data = json.loads(body)
                if isinstance(data, dict):
                    parsed_body = data
            except json.JSONDecodeError:
                parsed_body = {}

        msg = (
            parsed_body.get("error")
            or parsed_body.get("message")
            or f"HTTP {exc.code}: {exc.reason}"
        )

        if exc.code == 404 and "Session not found" in msg:
            return ClientResult(
                status="error",
                error_code="session_not_found",
                message=f"会话不存在: {msg}",
            )

        if exc.code == 400 and "Session not found" in msg:
            return ClientResult(
                status="error",
                error_code="session_not_found",
                message=f"会话不存在或连接已关闭: {msg}",
            )

        if "No active connection" in msg:
            return ClientResult(
                status="error",
                error_code="connection_failed",
                message=msg,
                suggestion=f"请确保 SSE 服务器已启动: snow --sse --sse-port {self._port}",
            )

        return ClientResult(
            status="error",
            error_code="server_error",
            message=msg,
        )

    def _connection_failed_result(self, exc: Exception) -> ClientResult:
        """构建连接失败结果."""
        return ClientResult(
            status="error",
            error_code="connection_failed",
            message=f"无法连接到 SSE 服务器 ({self._host}:{self._port}): {exc}",
            suggestion=f"请确保 SSE 服务器已启动: snow --sse --sse-port {self._port}",
        )

    def _log(self, text: str) -> None:
        """输出调试日志到 stderr."""
        if self._verbose:
            print(f"[snow-client-simple] {text}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    """解析命令行参数."""
    parser = argparse.ArgumentParser(description="Snow CLI SSE 全功能 Python 客户端")

    parser.add_argument("-m", "--message", help="发送给 AI 的文本消息")
    parser.add_argument("-s", "--session", help="会话 ID,用于连续对话")
    parser.add_argument(
        "-i",
        "--image",
        action="append",
        default=[],
        help="本地图片路径,可重复指定",
    )
    parser.add_argument(
        "--no-yolo",
        action="store_true",
        help="禁用 YOLO 模式,让非敏感工具也走确认流程",
    )

    parser.add_argument("--confirm", action="store_true", help="确认工具执行")
    parser.add_argument("--reject", action="store_true", help="拒绝工具执行")
    parser.add_argument("--answer", action="store_true", help="回答 AI 提问")
    parser.add_argument("--request-id", help="交互请求 requestId")
    parser.add_argument("--answer-text", help="回答内容,配合 --answer")

    parser.add_argument("-a", "--abort", action="store_true", help="中断当前任务")
    parser.add_argument("--switch-agent", help="切换主代理 ID")

    parser.add_argument("--list-sessions", action="store_true", help="列出会话")
    parser.add_argument("--load-session", help="加载指定会话")
    parser.add_argument("--delete-session", help="删除指定会话")

    parser.add_argument("--list-agents", action="store_true", help="列出可用主代理")

    parser.add_argument(
        "--list-rollback-points",
        action="store_true",
        help="列出当前会话的回滚点",
    )
    parser.add_argument("--rollback-to", type=int, help="回滚到指定消息索引")
    parser.add_argument(
        "--rollback-files",
        action="store_true",
        help="执行回滚时恢复文件",
    )
    parser.add_argument(
        "--rollback-file",
        action="append",
        default=[],
        help="回滚时仅恢复指定文件,可重复指定",
    )

    parser.add_argument("--health", action="store_true", help="健康检查")

    parser.add_argument("-H", "--host", default="localhost", help="SSE 服务地址")
    parser.add_argument("-p", "--port", default=9001, type=int, help="SSE 服务端口")
    parser.add_argument(
        "--connect-timeout",
        default=30,
        type=float,
        help="连接超时时间(秒)",
    )
    parser.add_argument(
        "--request-timeout",
        default=3600,
        type=float,
        help="等待请求完成超时时间(秒)",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="输出调试日志")

    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> Optional[str]:
    """校验参数组合是否合法."""
    interactive_flags = [args.confirm, args.reject, args.answer]
    if sum(1 for item in interactive_flags if item) > 1:
        return "--confirm/--reject/--answer 不能同时使用"

    if args.confirm or args.reject:
        if not args.request_id:
            return "--confirm 或 --reject 需要配合 --request-id"
        if not args.session:
            return "--confirm 或 --reject 需要配合 --session"

    if args.answer:
        if not args.request_id:
            return "--answer 需要配合 --request-id"
        if not args.answer_text:
            return "--answer 需要配合 --answer-text"
        if not args.session:
            return "--answer 需要配合 --session"

    if args.abort and not args.session:
        return "--abort 需要配合 --session"

    if args.list_rollback_points and not args.session:
        return "--list-rollback-points 需要配合 --session"

    if args.rollback_to is not None and not args.session:
        return "--rollback-to 需要配合 --session"

    if args.rollback_file and not args.rollback_files:
        return "--rollback-file 需要配合 --rollback-files"

    has_action = any(
        [
            bool(args.message),
            args.confirm,
            args.reject,
            args.answer,
            args.abort,
            bool(args.switch_agent),
            args.list_sessions,
            bool(args.load_session),
            bool(args.delete_session),
            args.list_agents,
            args.list_rollback_points,
            args.rollback_to is not None,
            args.health,
        ]
    )
    if not has_action:
        return "至少需要指定一个动作参数,例如 --message 或 --list-sessions"

    return None


def run_command(client: SimpleSnowSSEClient, args: argparse.Namespace) -> ClientResult:
    """按参数分发命令并执行."""
    if args.health:
        return client.health_check()

    if args.list_sessions:
        return client.list_sessions()

    if args.delete_session:
        return client.delete_session(args.delete_session)

    if args.list_rollback_points:
        return client.list_rollback_points(args.session)

    if args.rollback_to is not None:
        selected_files = list(args.rollback_file) if args.rollback_file else None
        return client.rollback_to(
            session_id=args.session,
            message_index=args.rollback_to,
            rollback_files=args.rollback_files,
            selected_files=selected_files,
        )

    if args.list_agents:
        return client.list_agents(session_id=args.session)

    if args.confirm:
        return client.send_tool_confirmation(
            session_id=args.session,
            request_id=args.request_id,
            approve=True,
        )

    if args.reject:
        return client.send_tool_confirmation(
            session_id=args.session,
            request_id=args.request_id,
            approve=False,
        )

    if args.answer:
        return client.send_question_answer(
            session_id=args.session,
            request_id=args.request_id,
            answer_text=args.answer_text,
        )

    if args.abort:
        return client.abort_task(args.session)

    active_session_id = args.session

    if args.load_session:
        load_result = client.load_session(args.load_session)
        if load_result.status != "success":
            return load_result
        active_session_id = args.load_session
        if not args.message and not args.switch_agent:
            return load_result

    if args.switch_agent:
        switch_result = client.switch_agent(
            agent_id=args.switch_agent,
            session_id=active_session_id,
        )
        if switch_result.status != "success":
            return switch_result
        if not args.message:
            return switch_result

    if args.message:
        return client.send_chat(
            content=args.message,
            session_id=active_session_id,
            images=args.image,
            yolo_mode=not args.no_yolo,
        )

    return ClientResult(
        status="error",
        error_code="invalid_args",
        message="参数组合无效,请检查命令",
    )


def main() -> int:
    """程序入口."""
    configure_stdio_utf8()
    args = parse_args()

    validation_error = validate_args(args)
    if validation_error:
        result = ClientResult(
            status="error",
            error_code="invalid_args",
            message=validation_error,
        )
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
        return 1

    client = SimpleSnowSSEClient(
        host=args.host,
        port=args.port,
        connect_timeout=args.connect_timeout,
        request_timeout=args.request_timeout,
        verbose=args.verbose,
    )

    result = run_command(client, args)
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    return 0 if result.status in {"success", "requires_confirmation", "requires_question"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
