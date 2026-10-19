"""Thin AWS adapters: Aurora PostgreSQL via the RDS Data API, CloudWatch metrics via
Embedded Metric Format, structured logging. boto3 is imported lazily."""
from __future__ import annotations

import json
import os
import time
from typing import Any, Iterable

_rds = None


def _client():
    global _rds
    if _rds is None:
        import boto3

        _rds = boto3.client("rds-data")
    return _rds


def _param(name: str, value: Any) -> dict:
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    if isinstance(value, bool):
        return {"name": name, "value": {"booleanValue": value}}
    if isinstance(value, int):
        return {"name": name, "value": {"longValue": value}}
    if isinstance(value, float):
        return {"name": name, "value": {"doubleValue": value}}
    if isinstance(value, (dict, list)):
        return {"name": name, "value": {"stringValue": json.dumps(value)}, "typeHint": "JSON"}
    return {"name": name, "value": {"stringValue": str(value)}}


def sql(statement: str, params: dict | None = None) -> list[dict]:
    """Run one statement; return rows as dicts."""
    resp = _client().execute_statement(
        resourceArn=os.environ["DB_CLUSTER_ARN"],
        secretArn=os.environ["DB_SECRET_ARN"],
        database=os.environ.get("DB_NAME", "watersentinel"),
        sql=statement,
        parameters=[_param(k, v) for k, v in (params or {}).items()],
        formatRecordsAs="JSON",
    )
    return json.loads(resp.get("formattedRecords", "[]"))


def sql_batch(statement: str, rows: Iterable[dict], chunk: int = 500) -> int:
    rows = list(rows)
    for i in range(0, len(rows), chunk):
        _client().batch_execute_statement(
            resourceArn=os.environ["DB_CLUSTER_ARN"],
            secretArn=os.environ["DB_SECRET_ARN"],
            database=os.environ.get("DB_NAME", "watersentinel"),
            sql=statement,
            parameterSets=[[_param(k, v) for k, v in r.items()] for r in rows[i : i + chunk]],
        )
    return len(rows)


def metric(name: str, value: float, unit: str = "Count", **dimensions: str) -> None:
    """Emit a CloudWatch metric using Embedded Metric Format (no API call needed)."""
    print(json.dumps({
        "_aws": {"Timestamp": int(time.time() * 1000), "CloudWatchMetrics": [{
            "Namespace": "WaterSentinel", "Dimensions": [list(dimensions.keys())] if dimensions else [[]],
            "Metrics": [{"Name": name, "Unit": unit}]}]},
        name: value, **dimensions,
    }))


def log(level: str, message: str, **fields: Any) -> None:
    print(json.dumps({"level": level, "message": message, **fields}, default=str))


def response(status: int, body: Any) -> dict:
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(body, default=str)}
