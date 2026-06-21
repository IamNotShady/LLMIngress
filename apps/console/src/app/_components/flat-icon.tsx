import Image from "next/image";

export type FlatIconName =
  | "add"
  | "cancel"
  | "confirm"
  | "delete"
  | "disable"
  | "edit"
  | "enable"
  | "export"
  | "filter"
  | "import"
  | "key"
  | "lock"
  | "refresh"
  | "save"
  | "unlock"
  | "view";

const flatIconFiles: Record<FlatIconName, string> = {
  add: "plus.svg",
  cancel: "cancel.svg",
  confirm: "ok.svg",
  delete: "empty_trash.svg",
  disable: "cancel.svg",
  edit: "edit_image.svg",
  enable: "ok.svg",
  export: "export.svg",
  filter: "search.svg",
  import: "import.svg",
  key: "key.svg",
  lock: "lock.svg",
  refresh: "refresh.svg",
  save: "checkmark.svg",
  unlock: "unlock.svg",
  view: "view_details.svg",
};

export function FlatIcon({ className, name }: { className?: string; name: FlatIconName }) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={className ? `flat-icon ${className}` : "flat-icon"}
      draggable={false}
      height={20}
      src={`/flat-color-icons/${flatIconFiles[name]}`}
      width={20}
    />
  );
}
