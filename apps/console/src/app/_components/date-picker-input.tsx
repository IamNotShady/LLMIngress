"use client";

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

type DatePickerInputProps = {
  defaultValue: string;
  id: string;
  name: string;
  pickerLabel: string;
};

const monthFormatter = new Intl.DateTimeFormat("en", {
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});
const weekDays = [
  { key: "sun", label: "S" },
  { key: "mon", label: "M" },
  { key: "tue", label: "T" },
  { key: "wed", label: "W" },
  { key: "thu", label: "T" },
  { key: "fri", label: "F" },
  { key: "sat", label: "S" },
];

export function DatePickerInput({ defaultValue, id, name, pickerLabel }: DatePickerInputProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => readVisibleMonth(defaultValue));
  const calendarDays = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const dialogId = `${id}-calendar`;
  const selectedDate = parseDateInput(value);

  useEffect(() => {
    setValue(defaultValue);
    setVisibleMonth(readVisibleMonth(defaultValue));
  }, [defaultValue]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="date-picker-input" ref={rootRef}>
      <input
        aria-controls={open ? dialogId : undefined}
        aria-haspopup="dialog"
        id={id}
        name={name}
        type="date"
        value={value}
        ref={inputRef}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          setValue(nextValue);
          setVisibleMonth(readVisibleMonth(nextValue));
        }}
        onClick={(event) => openDatePicker(event.currentTarget, setOpen)}
        onKeyDown={(event) => openDatePickerFromKeyboard(event, setOpen)}
      />
      {open ? (
        <div
          aria-label={`${pickerLabel} calendar`}
          className="date-picker-popover"
          id={dialogId}
          role="dialog"
        >
          <div className="date-picker-header">
            <button
              aria-label="Previous month"
              className="date-picker-nav-button"
              type="button"
              onClick={() => setVisibleMonth((month) => addMonths(month, -1))}
            >
              {"<"}
            </button>
            <strong>{monthFormatter.format(visibleMonth)}</strong>
            <button
              aria-label="Next month"
              className="date-picker-nav-button"
              type="button"
              onClick={() => setVisibleMonth((month) => addMonths(month, 1))}
            >
              {">"}
            </button>
          </div>
          <div className="date-picker-weekdays" aria-hidden="true">
            {weekDays.map((day) => (
              <span key={day.key}>{day.label}</span>
            ))}
          </div>
          <div className="date-picker-grid">
            {calendarDays.map((cell) => (
              <CalendarDayCell
                cell={cell}
                key={cell.key}
                selectedDate={selectedDate}
                onSelect={(date) => {
                  setValue(formatDateInput(date));
                  setOpen(false);
                  inputRef.current?.focus();
                }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function openDatePickerFromKeyboard(
  event: KeyboardEvent<HTMLInputElement>,
  showFallbackPicker: (open: boolean) => void,
) {
  if (![" ", "ArrowDown", "Enter"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  openDatePicker(event.currentTarget, showFallbackPicker);
}

function openDatePicker(input: HTMLInputElement, showFallbackPicker: (open: boolean) => void) {
  if (typeof input.showPicker !== "function") {
    showFallbackPicker(true);
    input.focus();
    return;
  }

  try {
    input.showPicker();
  } catch {
    showFallbackPicker(true);
    input.focus();
  }
}

function CalendarDayCell({
  cell,
  onSelect,
  selectedDate,
}: {
  cell: { date: Date | null; key: string };
  onSelect: (date: Date) => void;
  selectedDate: Date | null;
}) {
  if (!cell.date) {
    return <span aria-hidden="true" className="date-picker-day-spacer" />;
  }
  const date = cell.date;

  return (
    <button
      aria-pressed={isSameDay(date, selectedDate)}
      className="date-picker-day"
      data-date={formatDateInput(date)}
      type="button"
      onClick={() => onSelect(date)}
    >
      {date.getUTCDate()}
    </button>
  );
}

function readVisibleMonth(value: string) {
  const parsed = parseDateInput(value);
  const fallback = parsed ?? new Date();
  return new Date(Date.UTC(fallback.getUTCFullYear(), fallback.getUTCMonth(), 1));
}

function parseDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function addMonths(month: Date, delta: number) {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + delta, 1));
}

function buildCalendarDays(month: Date) {
  const firstDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const daysInMonth = new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const monthKey = formatDateInput(firstDay).slice(0, 7);
  const days: Array<{ date: Date | null; key: string }> = Array.from(
    { length: firstDay.getUTCDay() },
    (_, spacer) => ({ date: null, key: `${monthKey}-spacer-${spacer}` }),
  );
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day));
    days.push({ date, key: formatDateInput(date) });
  }
  return days;
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isSameDay(a: Date, b: Date | null) {
  if (!b) {
    return false;
  }
  return formatDateInput(a) === formatDateInput(b);
}
