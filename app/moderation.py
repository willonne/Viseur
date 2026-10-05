import argparse
from datetime import datetime, timezone
from pathlib import Path
import sqlite3

DATABASE = Path(__file__).resolve().parent / "data" / "viseur.db"


def connect():
    if not DATABASE.exists():
        raise SystemExit("Base absente : aucun signalement n’a encore été reçu.")

    DATABASE.chmod(0o600)
    connection = sqlite3.connect(DATABASE)

    columns = {
        row[1] for row in connection.execute("PRAGMA table_info(reports)")
    }

    if "status" not in columns:
        connection.execute(
            "ALTER TABLE reports "
            "ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'"
        )

    if "reviewed_at" not in columns:
        connection.execute(
            "ALTER TABLE reports ADD COLUMN reviewed_at TEXT"
        )

    connection.commit()
    return connection

def list_reports():
    with connect() as connection:
        reports = connection.execute(
            """
            SELECT id, created_at, reason, status
            FROM reports
            ORDER BY created_at DESC
            """
        ).fetchall()

    if not reports:
        print("Aucun signalement.")
        return

    for report_id, created_at, reason, status in reports:
        print(f"{report_id} | {created_at} | {reason} | {status}")


def show_report(report_id):
    with connect() as connection:
        report = connection.execute(
            """
            SELECT id, created_at, reason, description, status, reviewed_at
            FROM reports
            WHERE id = ?
            """,
            (report_id,),
        ).fetchone()

    if not report:
        raise SystemExit("Signalement introuvable.")

    labels = (
        "Référence",
        "Reçu le",
        "Motif",
        "Description",
        "État",
        "Examiné le",
    )
    for label, value in zip(labels, report):
        print(f"{label} : {value or '-'}")


def mark_reviewed(report_id):
    reviewed_at = datetime.now(timezone.utc).isoformat()

    with connect() as connection:
        cursor = connection.execute(
            """
            UPDATE reports
            SET status = 'reviewed', reviewed_at = ?
            WHERE id = ?
            """,
            (reviewed_at, report_id),
        )

    if cursor.rowcount == 0:
        raise SystemExit("Signalement introuvable.")

    print("Signalement marqué comme examiné.")


def main():
    parser = argparse.ArgumentParser(
        description="Consultation locale des signalements Viseur."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list", help="Lister les signalements")

    show_parser = subparsers.add_parser("show", help="Afficher un signalement")
    show_parser.add_argument("report_id")

    review_parser = subparsers.add_parser(
        "review",
        help="Marquer un signalement comme examiné",
    )
    review_parser.add_argument("report_id")

    args = parser.parse_args()

    if args.command == "list":
        list_reports()
    elif args.command == "show":
        show_report(args.report_id)
    elif args.command == "review":
        mark_reviewed(args.report_id)


if __name__ == "__main__":
    main()
