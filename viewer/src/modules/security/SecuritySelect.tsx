import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SecuritySelectOption<T extends string> {
  value: T;
  label: string;
  /** Optional number shown on the right (e.g. findings count). */
  count?: number;
  /** Optional colored dot shown before the label. */
  tone?: "critical" | "high" | "medium" | "low" | "info";
}

interface SecuritySelectProps<T extends string> {
  value: T;
  options: SecuritySelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}

const MENU_MAX_HEIGHT = 320;
const MENU_MIN_WIDTH = 190;
const VIEWPORT_GAP = 12;

interface MenuPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

export default function SecuritySelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: SecuritySelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );
  const selected = options[selectedIndex];

  const close = useCallback(() => setOpen(false), []);

  const openMenu = useCallback(() => {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }, [selectedIndex]);

  const choose = useCallback(
    (index: number) => {
      const option = options[index];
      if (option) onChange(option.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [options, onChange]
  );

  // Position the menu with fixed coordinates. The findings panel uses
  // overflow:hidden, so an absolutely positioned menu would be clipped.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.max(rect.width, MENU_MIN_WIDTH);
    const left = Math.max(
      VIEWPORT_GAP,
      Math.min(rect.left, window.innerWidth - width - VIEWPORT_GAP)
    );

    const wanted = Math.min(MENU_MAX_HEIGHT, options.length * 38 + 12);
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_GAP;
    const spaceAbove = rect.top - VIEWPORT_GAP;
    const placeBelow = spaceBelow >= wanted || spaceBelow >= spaceAbove;

    setPosition(
      placeBelow
        ? {
            top: rect.bottom + 6,
            left,
            width,
            maxHeight: Math.min(MENU_MAX_HEIGHT, spaceBelow - 6),
          }
        : {
            bottom: window.innerHeight - rect.top + 6,
            left,
            width,
            maxHeight: Math.min(MENU_MAX_HEIGHT, spaceAbove - 6),
          }
    );
  }, [open, options.length]);

  // Close on outside click, window resize, or scrolling anything but the menu.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }

    function onScroll(event: Event) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  // Keep the keyboard-active option visible.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, position]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) openMenu();
        else setActiveIndex((index) => Math.min(index + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) openMenu();
        else setActiveIndex((index) => Math.max(index - 1, 0));
        break;
      case "Home":
        if (open) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (open) {
          event.preventDefault();
          setActiveIndex(options.length - 1);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) choose(activeIndex);
        else openMenu();
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          close();
        }
        break;
      case "Tab":
        close();
        break;
      default:
        break;
    }
  }

  return (
    <div className="security-select">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        className="security-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open ? `${listId}-option-${activeIndex}` : undefined
        }
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="security-select-value">{selected?.label}</span>
        <ChevronDown size={16} className="security-select-chevron" />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="security-select-menu"
            style={position}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;

              return (
                <div
                  key={option.value}
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  data-active={index === activeIndex}
                  className="security-select-option"
                  // Keep focus on the trigger so keyboard navigation continues.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                >
                  <span className="security-select-check">
                    {isSelected && <Check size={14} />}
                  </span>

                  {option.tone && (
                    <span
                      className={`security-select-dot security-dot-${option.tone}`}
                    />
                  )}

                  <span className="security-select-label">{option.label}</span>

                  {option.count !== undefined && (
                    <span className="security-select-count">
                      {option.count}
                    </span>
                  )}
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}