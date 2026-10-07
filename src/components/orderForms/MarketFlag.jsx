import React, { useState } from "react";
import { marketFlag } from "./format";

// A market's flag as an image. Windows can't draw flag emoji (it shows the two
// letters instead), so the flag is fetched as a picture, the way the Canvas
// does it. Non-country entries (the globe for Middle East) stay as emoji, and
// a market with no known flag leaves the slot empty so names still line up.

// "🇭🇷" → "hr". "" for anything that isn't a two-letter flag.
const flagCode = (flag) => {
  const points = [...flag].map((ch) => ch.codePointAt(0));
  return points.length === 2 && points.every((p) => p >= 127462 && p <= 127487)
    ? points.map((p) => String.fromCharCode(p - 127397)).join("").toLowerCase()
    : "";
};

export default function MarketFlag({ name, className = "w-5 h-[14px]" }) {
  const [failed, setFailed] = useState(false);
  const flag = marketFlag(name);
  const code = flag ? flagCode(flag) : "";

  return (
    <span className={`inline-flex items-center justify-center shrink-0 ${className}`} aria-hidden="true">
      {code && !failed ? (
        <img
          src={`https://flagcdn.com/w40/${code}.png`}
          alt=""
          onError={() => setFailed(true)}
          className="w-full h-full rounded-[3px] object-cover ring-1 ring-black/10"
        />
      ) : code ? (
        <span className="text-[9px] font-black tracking-wider text-[#768994]">{code.toUpperCase()}</span>
      ) : (
        <span className="text-sm leading-none">{flag}</span>
      )}
    </span>
  );
}
