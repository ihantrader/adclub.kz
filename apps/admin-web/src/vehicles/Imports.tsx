import type {
  AdminVehicleImport,
  VehicleImportTemplateResponse,
  VehicleOptionKind,
} from "@adclub/contracts";
import {
  Button,
  EmptyState,
  FileDrop,
  LoadingContent,
  SkeletonList,
  StatusBadge,
  TableToolbar,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { Header, Muted, RowTitle, rowLink, Table, type Column } from "../layout/layout";
import { navigateTo, vehicleImportPath } from "../router";
import { useLoad } from "../use-load";
import { LoadError, MoreButton, RefreshButton, usePaged, vehiclesTabs } from "./shared";
import {
  COLUMN_TEXT,
  countText,
  IMPORT_STATUS_TEXT,
  importFileErrorText,
  importNumbers,
  NOT_CSV_TEXT,
  NOT_TABLE_TEXT,
  OPTION_KIND_TEXT,
  personText,
  ROWS,
  templateFileText,
  uploadContentType,
} from "./vehicle-words";

const HISTORY_COLUMNS: Column[] = [
  { key: "file", header: "Файл" },
  { key: "uploaded", header: "Загрузил", width: 160 },
  { key: "status", header: "Состояние", width: 190 },
  { key: "numbers", header: "Итог" },
  { key: "applied", header: "Применил", width: 160 },
];

const TEMPLATE_COLUMNS: Column[] = [
  { key: "column", header: "Колонка", width: 230 },
  { key: "about", header: "Что в ней" },
  { key: "example", header: "Пример", width: 150 },
];

/** A spreadsheet of Excel, not its CSV: the server's own words, said before the upload. */
function isExcel(file: File): boolean {
  return /\.xlsx?$/i.test(file.name);
}

/** Who did it and when, in two lines of a cell. */
function PersonCell({
  person,
  at,
}: {
  person: Parameters<typeof personText>[0];
  at: string | null;
}) {
  if (!person) return <Muted>—</Muted>;
  return (
    <span className="row-title">
      <span className="cell-one-line">{personText(person)}</span>
      <span className="row-title__sub nowrap">{formatMoment(at)}</span>
    </span>
  );
}

/**
 * A-CAR-02 «Импорт» (SCREENS 7.2; TASK-035.B, TASK-080): the zone of the
 * file with «Загрузить и проверить» as its action (a file the server can't
 * take is refused at once, in words), «Скачать шаблон» and what each column
 * takes folded under it; then the history — who uploaded and applied, when,
 * what came of it; a row opens its report.
 */
export function Imports() {
  const online = useOnline();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const template = useLoad<VehicleImportTemplateResponse>(
    () => apiClient.getVehicleImportTemplate(),
    "template",
  );
  const history = usePaged<AdminVehicleImport>(async (cursor) => {
    const page = await apiClient.listVehicleImports({ query: { limit: 20, cursor } });
    return { items: page.imports, total: page.total, nextCursor: page.nextCursor };
  }, "imports");

  const download = () => {
    const data = template.data;
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([templateFileText(data.csv)], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = data.fileName;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const answer = await apiClient.uploadVehicleImport(file, {
        contentType: uploadContentType(file.type),
        query: { fileName: file.name.slice(0, 200) },
      });
      navigateTo(vehicleImportPath(answer.import.id));
    } catch (thrown) {
      setUploadError(importFileErrorText(thrown));
    } finally {
      setUploading(false);
    }
  };

  const optionsByKind = new Map<
    VehicleOptionKind,
    { name: string; spellings: string; key: string }[]
  >();
  for (const option of template.data?.options ?? []) {
    const spellings = [option.code, option.names.kk, option.names.en].filter(
      (name, index, all): name is string =>
        !!name && name !== option.names.ru && all.indexOf(name) === index,
    );
    optionsByKind.set(option.kind, [
      ...(optionsByKind.get(option.kind) ?? []),
      { name: option.names.ru, spellings: spellings.join(", "), key: option.code },
    ]);
  }

  return (
    <>
      <Header
        title="Автомобили"
        tabs={vehiclesTabs("imports")}
        actions={
          <>
            <RefreshButton onClick={history.first.reload} />
            <Button
              variant="secondary"
              size="s"
              icon="download"
              onClick={download}
              disabled={!template.data}
            >
              Скачать шаблон
            </Button>
          </>
        }
      />

      <section className="section" aria-labelledby="import-upload">
        <h2 id="import-upload" className="section__title">
          Загрузить файл
        </h2>
        <FileDrop
          title="Перетащите файл CSV сюда или выберите его"
          hint={
            <>
              Одна строка — одна модификация. Таблица CSV в UTF-8 (в Excel: «Сохранить как → CSV
              UTF-8»), разделитель — запятая или точка с запятой. После загрузки сервер проверит
              строки и покажет отчёт; до «Применить» в справочнике ничего не меняется.
            </>
          }
          accept={[".csv", "text/csv"]}
          file={file}
          disabled={!online}
          onFile={(chosen) => {
            setFile(chosen);
            setUploadError(null);
          }}
          onReject={(problem, rejected) => {
            setFile(null);
            if (problem === "type")
              setUploadError(isExcel(rejected) ? NOT_CSV_TEXT : NOT_TABLE_TEXT);
          }}
          error={uploadError ?? undefined}
          progress={uploading ? "Загружаем и проверяем файл…" : undefined}
          icon="fileSpreadsheet"
          action={
            <Button size="s" onClick={upload} loading={uploading} disabled={!file || !online}>
              Загрузить и проверить
            </Button>
          }
        />
        <LoadError error={template.error} retry={template.reload} />
        {template.data && (
          <details className="disclosure">
            <summary className="disclosure__summary">
              Что в шаблоне: колонки и допустимые значения
            </summary>
            <div className="vehicles-stack">
              <Table label="Колонки шаблона" columns={TEMPLATE_COLUMNS} className="template-table">
                {template.data.columns.map((column) => (
                  <tr key={column.name}>
                    <td>
                      <span className="row-title">
                        <span className="vehicles-name nowrap">{column.name}</span>
                        <span className="row-title__sub">
                          {COLUMN_TEXT[column.name]}
                          {column.required ? " · обязательная" : ""}
                        </span>
                      </span>
                    </td>
                    <td className="ac-text-body-s">{column.description}</td>
                    <td className="nowrap">{column.example || <Muted>—</Muted>}</td>
                  </tr>
                ))}
              </Table>
              <div className="card">
                <div className="cell-stack">
                  <h3 className="card__title">Допустимые значения списков</h3>
                  <p className="section__note">
                    Код или любое название; новых значений файл не создаёт — их добавляют во вкладке
                    «Справочные списки».
                  </p>
                </div>
                <dl className="vehicles-values">
                  {(["body", "transmission", "drive", "fuel"] as const).map((kind) => (
                    <div key={kind} className="vehicles-values__row">
                      <dt className="ac-text-caption-strong">{OPTION_KIND_TEXT[kind]}</dt>
                      <dd>
                        <ul className="vehicles-values__list">
                          {(optionsByKind.get(kind) ?? []).map((option) => (
                            <li key={option.key}>
                              {option.name}
                              {option.spellings && (
                                <span className="code-text"> {option.spellings}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </details>
        )}
      </section>

      <section className="section" aria-labelledby="import-history">
        <div className="cell-stack">
          <h2 id="import-history" className="section__title">
            История импортов
          </h2>
          <p className="section__note">
            Изменения справочника видны в приложении не позже чем через минуту после применения.
          </p>
        </div>
        <LoadError error={history.first.error} retry={history.first.reload} />
        <LoadingContent
          ready={history.first.data !== undefined}
          indicator={history.first.indicator}
          label="Загрузка"
          swapKey={history.first.answerKey}
          skeleton={<SkeletonList rows={3} label="Загрузка" />}
        >
          <div className="list-block">
            <TableToolbar total={history.items.length === 0 ? null : history.total} />
            {history.items.length === 0 ? (
              <EmptyState
                compact
                icon="clock"
                title="Импортов ещё не было"
                text="Загрузите первый файл"
              />
            ) : (
              <Table label="История импортов" columns={HISTORY_COLUMNS}>
                {history.items.map((entry) => (
                  <tr key={entry.id} {...rowLink(vehicleImportPath(entry.id))}>
                    <td>
                      <RowTitle
                        href={vehicleImportPath(entry.id)}
                        sub={countText(entry.rowCount, ROWS)}
                      >
                        <span className="cell-one-line" title={entry.fileName ?? undefined}>
                          {entry.fileName ?? "Без имени"}
                        </span>
                      </RowTitle>
                    </td>
                    <td>
                      <PersonCell person={entry.uploadedBy} at={entry.createdAt} />
                    </td>
                    <td>
                      <StatusBadge kind="vehicleImport" status={entry.status}>
                        {IMPORT_STATUS_TEXT[entry.status]}
                      </StatusBadge>
                    </td>
                    <td className="ac-text-body-s">{importNumbers(entry)}</td>
                    <td>
                      <PersonCell person={entry.appliedBy} at={entry.appliedAt} />
                    </td>
                  </tr>
                ))}
              </Table>
            )}
            <MoreButton list={history} />
          </div>
        </LoadingContent>
      </section>
    </>
  );
}
