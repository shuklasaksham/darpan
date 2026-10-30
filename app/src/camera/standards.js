// Darpan's Shooting Standards and Coach Script (v1, October 2026): every live
// check, the order to fix them in, and the exact lines to say.
//
// Each check has:
//   area   where it sits in "What to fix first" (1 orientation … 9 delivery)
//   tag    critical | before | recording (also checked while recording) | after
//   ruin   while recording, only these are spoken: the take is being ruined
//   en / hinglish / hi   the line shown and said, per language
//   hs     the Hinglish line written in Devanagari, so a Hindi voice says the
//          same words the creator reads
//   praise the one line said once the creator fixes it
// {x} is filled from what the camera sees ([towel], [left], [fan] …), with a
// word per language: { en, hinglish, hi }.

const PERFECT = { en: 'Perfect.', hinglish: 'Ekdum perfect.', hi: 'एकदम बढ़िया।', hs: 'एकदम परफ़ेक्ट।' };
const HOLD = { en: 'Perfect. Hold it there.', hinglish: 'Bilkul sahi. Aise hi raho.', hi: 'बिल्कुल सही। ऐसे ही रहो।' };
const SPOT = { en: "That's the spot.", hinglish: 'Yahi sahi jagah hai.', hi: 'यही सही जगह है।' };

export const AREAS = {
  orientation: 1,
  steady: 2,
  light: 3,
  framing: 4,
  angle: 5,
  background: 6,
  sound: 7,
  lens: 8,
  outfit: 8.5, // not in the fix-first list; checked with the lens and settings
  delivery: 9,
};

export const CHECKS = {
  // 4.1 Orientation
  O1: { area: 'orientation', tag: 'critical', glyph: 'rotate', en: 'Turn your phone upright for this one.', hinglish: 'Phone seedha khada kar lo.', hi: 'फ़ोन सीधा खड़ा कर लो।', praise: PERFECT },
  O2: { area: 'orientation', tag: 'critical', glyph: 'rotate', en: 'Turn your phone sideways for this one.', hinglish: 'Phone ko side mein ghuma lo.', hi: 'फ़ोन को साइड में घुमा लो।', praise: PERFECT },

  // 4.2 Phone steady and straight
  S1: { area: 'steady', tag: 'critical', glyph: 'frame', en: 'Straighten the phone a little.', hinglish: 'Phone thoda seedha karo.', hi: 'फ़ोन थोड़ा सीधा करो।', praise: { en: 'Nice and straight.', hinglish: 'Ekdum seedha.', hi: 'एकदम सीधा।' } },
  S2: { area: 'steady', tag: 'critical', glyph: 'frame', en: 'Rest the phone on something steady.', hinglish: 'Phone kisi cheez pe tika do.', hi: 'फ़ोन किसी चीज़ पर टिका दो।', hs: 'फ़ोन किसी चीज़ पे टिका दो।', praise: { en: 'Steady. Good.', hinglish: 'Bilkul steady.', hi: 'बिल्कुल स्थिर।', hs: 'बिल्कुल स्टेडी।' } },
  S3: { area: 'steady', tag: 'recording', ruin: true, glyph: 'frame', en: 'Fix the phone in place, then go again.', hinglish: 'Phone set karo, phir dobara.', hi: 'फ़ोन सेट करो, फिर दोबारा।', praise: { en: 'Ready when you are.', hinglish: 'Ready ho toh shuru karo.', hi: 'तैयार हो तो शुरू करो।', hs: 'रेडी हो तो शुरू करो।' } },

  // 4.3 Light
  L1: { area: 'light', tag: 'critical', glyph: 'light', en: 'Light is behind you. Turn to the window.', hinglish: 'Light peeche hai. Window ki taraf mudo.', hi: 'रोशनी पीछे है। खिड़की की तरफ़ मुड़ो।', hs: 'लाइट पीछे है। विंडो की तरफ़ मुड़ो।', praise: { en: 'Great light. Hold it there.', hinglish: 'Light ekdum sahi hai.', hi: 'रोशनी एकदम सही है।', hs: 'लाइट एकदम सही है।' } },
  L2: { area: 'light', tag: 'critical', glyph: 'light', en: 'Switch on a light in front of you.', hinglish: 'Saamne ek light on karo.', hi: 'सामने एक लाइट जलाओ।', hs: 'सामने एक लाइट ऑन करो।', praise: { en: 'Much better.', hinglish: 'Ab sahi hai.', hi: 'अब सही है।' } },
  L3: { area: 'light', tag: 'before', glyph: 'light', en: 'Step away from the light above you.', hinglish: 'Upar wali light se thoda hat jao.', hi: 'ऊपर वाली लाइट से थोड़ा हट जाओ।', hs: 'ऊपर वाली लाइट से थोड़ा हट जाओ।', praise: { en: "That's softer. Good.", hinglish: 'Ab light soft hai. Badhiya.', hi: 'अब रोशनी नरम है। बढ़िया।', hs: 'अब लाइट सॉफ़्ट है। बढ़िया।' } },
  L4: { area: 'light', tag: 'before', glyph: 'light', en: 'Turn a little toward the light.', hinglish: 'Light ki taraf thoda ghoomo.', hi: 'लाइट की तरफ़ थोड़ा घूमो।', praise: PERFECT },
  L5: { area: 'light', tag: 'before', glyph: 'light', en: 'Keep one light. Switch the other off.', hinglish: 'Ek hi light rakho, doosri band karo.', hi: 'एक ही लाइट रखो, दूसरी बंद करो।', praise: { en: 'Colours look right now.', hinglish: 'Ab colours sahi hain.', hi: 'अब रंग सही हैं।', hs: 'अब कलर्स सही हैं।' } },
  L6: { area: 'light', tag: 'recording', glyph: 'light', en: 'Tap and hold on your face to lock it.', hinglish: 'Apne face pe tap karke hold karo.', hi: 'अपने चेहरे पर टैप करके दबाए रखो।', hs: 'अपने फ़ेस पे टैप करके होल्ड करो।', praise: { en: 'Locked. Good.', hinglish: 'Lock ho gaya. Badhiya.', hi: 'लॉक हो गया। बढ़िया।' } },

  // 4.4 Distance and framing
  F1: { area: 'framing', tag: 'critical', glyph: 'frame', en: 'Move back a little.', hinglish: 'Thoda peeche ho jao.', hi: 'थोड़ा पीछे हो जाओ।', praise: SPOT },
  F2: { area: 'framing', tag: 'before', glyph: 'frame', en: 'Come one step closer.', hinglish: 'Ek kadam aage aao.', hi: 'एक कदम आगे आओ।', praise: SPOT },
  F3: { area: 'framing', tag: 'critical', glyph: 'frame', en: 'Step back so your whole head is in.', hinglish: 'Peeche jao, poora sar frame mein aaye.', hi: 'पीछे जाओ, ताकि पूरा सिर फ़्रेम में आए।', hs: 'पीछे जाओ, पूरा सर फ़्रेम में आए।', praise: HOLD },
  // The standards say "Raise the phone a little", but too much space above the
  // head means the camera sits too high: raising it adds more. Lowering fixes it.
  F4: { area: 'framing', tag: 'before', glyph: 'frame', en: 'Lower the phone a little.', hinglish: 'Phone thoda neeche karo.', hi: 'फ़ोन थोड़ा नीचे करो।', praise: PERFECT },
  F5: { area: 'framing', tag: 'critical', glyph: 'frame', en: 'Move a little to your {x}.', hinglish: 'Thoda apne {x} aao.', hi: 'थोड़ा अपने {x} आओ।', praise: { en: 'Centred. Hold it there.', hinglish: 'Bilkul beech mein.', hi: 'बिल्कुल बीच में।' } },
  F6: { area: 'framing', tag: 'critical', glyph: 'frame', en: 'Step back so your full {x} shows.', hinglish: 'Peeche jao, poora {x} dikhe.', hi: 'पीछे जाओ, ताकि पूरा {x} दिखे।', hs: 'पीछे जाओ, पूरा {x} दिखे।', praise: { en: 'Now we can see it all.', hinglish: 'Ab poora dikh raha hai.', hi: 'अब पूरा दिख रहा है।' } },
  F7: { area: 'framing', tag: 'before', glyph: 'frame', en: 'Move up a bit; the caption will cover you.', hinglish: 'Thoda upar aao, caption aa jayega.', hi: 'थोड़ा ऊपर आओ, नीचे कैप्शन आएगा।', hs: 'थोड़ा ऊपर आओ, कैप्शन आ जाएगा।', praise: { en: 'Clear of the caption.', hinglish: 'Ab caption se bach gaye.', hi: 'अब कैप्शन से बच गए।' } },

  // 4.5 Angle
  A1: { area: 'angle', tag: 'critical', glyph: 'frame', en: 'Raise the phone to eye level.', hinglish: 'Phone aankhon ki height pe rakho.', hi: 'फ़ोन आँखों की ऊँचाई पर रखो।', hs: 'फ़ोन आँखों की हाइट पे रखो।', praise: HOLD },
  A2: { area: 'angle', tag: 'critical', glyph: 'frame', en: 'Lower the phone to eye level.', hinglish: 'Phone aankhon tak neeche karo.', hi: 'फ़ोन आँखों तक नीचे करो।', praise: HOLD },
  A3: { area: 'angle', tag: 'before', glyph: 'frame', en: 'Lower the phone to waist height.', hinglish: 'Phone kamar ki height pe rakho.', hi: 'फ़ोन कमर की ऊँचाई पर रखो।', hs: 'फ़ोन कमर की हाइट पे रखो।', praise: { en: 'Outfit looks great now.', hinglish: 'Ab outfit bahut accha dikh raha hai.', hi: 'अब आउटफ़िट बहुत अच्छा दिख रहा है।' } },
  A4: { area: 'angle', tag: 'before', glyph: 'frame', en: 'Turn your body toward the phone.', hinglish: 'Phone ki taraf mudo.', hi: 'फ़ोन की तरफ़ मुड़ो।', praise: { en: 'Good.', hinglish: 'Badhiya.', hi: 'बढ़िया।' } },

  // 4.6 Background
  B1: { area: 'background', tag: 'before', glyph: 'frame', en: 'Move the {x} out of frame.', hinglish: '{X} frame se hata do.', hi: '{x} फ़्रेम से हटा दो।', praise: { en: 'Clean background. Nice.', hinglish: 'Background ekdum clean.', hi: 'बैकग्राउंड एकदम साफ़।', hs: 'बैकग्राउंड एकदम क्लीन।' } },
  B2: { area: 'background', tag: 'before', glyph: 'frame', en: 'Try the {x} for this topic.', hinglish: 'Is topic ke liye {x} wala corner try karo.', hi: 'इस टॉपिक के लिए {x} वाला कोना आज़माओ।', hs: 'इस टॉपिक के लिए {x} वाला कॉर्नर ट्राई करो।', praise: { en: 'That suits the topic.', hinglish: 'Yeh topic ke saath jachta hai.', hi: 'यह टॉपिक के साथ जँचता है।', hs: 'ये टॉपिक के साथ जचता है।' } },
  B3: { area: 'background', tag: 'before', glyph: 'frame', en: 'Step forward, away from the wall.', hinglish: 'Deewar se thoda aage aao.', hi: 'दीवार से थोड़ा आगे आओ।', praise: { en: 'Better depth.', hinglish: 'Ab frame mein gehraai hai.', hi: 'अब फ़्रेम में गहराई है।' } },
  B4: { area: 'background', tag: 'recording', ruin: true, glyph: 'frame', en: 'Wait for the background to clear.', hinglish: 'Peeche clear hone do.', hi: 'पीछे साफ़ होने दो।', hs: 'पीछे क्लियर होने दो।', praise: { en: 'All clear. Go.', hinglish: 'Sab clear. Shuru karo.', hi: 'सब साफ़। शुरू करो।', hs: 'सब क्लियर। शुरू करो।' } },

  // 4.7 Sound
  SD1: { area: 'sound', tag: 'critical', glyph: 'voice', en: 'Switch off the {x} for this take.', hinglish: 'Is take ke liye {x} band karo.', hi: 'इस टेक के लिए {x} बंद करो।', praise: { en: 'Nice and quiet.', hinglish: 'Ab bilkul shaant.', hi: 'अब बिल्कुल शांत।' } },
  SD2: { area: 'sound', tag: 'before', glyph: 'voice', en: 'Come closer, or speak up a little.', hinglish: 'Thoda paas aao, ya thoda zor se bolo.', hi: 'थोड़ा पास आओ, या थोड़ा ज़ोर से बोलो।', praise: { en: 'You sound clear.', hinglish: 'Awaaz saaf aa rahi hai.', hi: 'आवाज़ साफ़ आ रही है।' } },
  SD3: { area: 'sound', tag: 'before', glyph: 'voice', en: 'Try a smaller room with curtains.', hinglish: 'Parde wala chhota kamra try karo.', hi: 'पर्दों वाला छोटा कमरा आज़माओ।', hs: 'पर्दे वाला छोटा कमरा ट्राई करो।', praise: { en: "Echo's gone.", hinglish: 'Goonj chali gayi.', hi: 'गूँज चली गई।' } },
  SD4: { area: 'sound', tag: 'recording', glyph: 'voice', en: 'Speak a little softer.', hinglish: 'Thoda halka bolo.', hi: 'थोड़ा धीमे बोलो।', hs: 'थोड़ा हल्का बोलो।', praise: { en: 'Clean now.', hinglish: 'Ab awaaz saaf hai.', hi: 'अब आवाज़ साफ़ है।' } },

  // 4.8 Lens and camera settings
  C1: { area: 'lens', tag: 'before', glyph: 'frame', en: 'Wipe your camera lens.', hinglish: 'Camera lens saaf kar lo.', hi: 'कैमरे का लेंस साफ़ कर लो।', hs: 'कैमरा लेंस साफ़ कर लो।', praise: { en: 'Sharp now.', hinglish: 'Ab ekdum saaf dikh raha hai.', hi: 'अब एकदम साफ़ दिख रहा है।' } },
  C2: { area: 'lens', tag: 'before', glyph: 'frame', en: 'Tap on your face to focus.', hinglish: 'Apne face pe tap karo.', hi: 'अपने चेहरे पर टैप करो।', hs: 'अपने फ़ेस पे टैप करो।', praise: { en: 'In focus.', hinglish: 'Focus sahi hai.', hi: 'फ़ोकस सही है।' } },

  // 4.9 Outfit and look: only how the outfit fits the topic or shows on camera.
  D1: { area: 'outfit', tag: 'before', glyph: 'frame', en: 'A neat shirt would suit this topic.', hinglish: 'Is topic ke liye ek neat shirt try karo.', hi: 'इस टॉपिक के लिए एक साफ़-सुथरी शर्ट पहनकर देखो।', hs: 'इस टॉपिक के लिए एक नीट शर्ट ट्राई करो।', praise: { en: 'Looks sharp.', hinglish: 'Bahut accha lag raha hai.', hi: 'बहुत अच्छा लग रहा है।' } },
  D2: { area: 'outfit', tag: 'before', glyph: 'frame', en: 'Move the {x} so the work shows.', hinglish: '{X} thoda side karo, kaam dikhe.', hi: '{x} थोड़ी साइड करो, ताकि काम दिखे।', hs: '{x} थोड़ा साइड करो, काम दिखे।', praise: { en: 'Now it really shows.', hinglish: 'Ab saaf dikh raha hai.', hi: 'अब साफ़ दिख रहा है।' } },

  // 4.10 Delivery: V1–V6 are notes after the take (server); V7 is live.
  V7: { area: 'delivery', tag: 'recording', ruin: true, glyph: 'voice', en: 'Your line is on the teleprompter. Go again.', hinglish: 'Line teleprompter pe hai, dobara karo.', hi: 'लाइन टेलीप्रॉम्प्टर पर है, दोबारा करो।', hs: 'लाइन टेलीप्रॉम्प्टर पे है, दोबारा करो।', praise: { en: 'Nailed it.', hinglish: 'Kamaal kar diya.', hi: 'कमाल कर दिया।' } },

  // Not in the standards: shown on screen only, never spoken, so the creator
  // knows why nothing else is being checked. The mic going dead mid-take is
  // "sound gone" from rule 10, so it is spoken.
  NOFACE: { area: 'framing', tag: 'critical', silent: true, glyph: 'frame', en: 'Step into the frame.', hinglish: 'Frame mein aao.', hi: 'फ़्रेम में आओ।', praise: null },
  MIC: { area: 'sound', tag: 'recording', ruin: true, glyph: 'voice', en: "Can't hear the mic.", hinglish: 'Mic se awaaz nahi aa rahi.', hi: 'माइक से आवाज़ नहीं आ रही।', praise: null },
};

/** Section 6: said once when every check passes. */
export const ALL_PASS = HOLD;

/** Fillers for F5: the creator's own left and right. */
export const SIDES = {
  left: { en: 'left', hinglish: 'left', hi: 'बाएँ', hs: 'लेफ़्ट' },
  right: { en: 'right', hinglish: 'right', hi: 'दाएँ', hs: 'राइट' },
};

const ORDER = Object.keys(CHECKS);

/** Lower comes first: area, then the order checks appear in the standards. */
export function rank(id) {
  const c = CHECKS[id];
  return (c ? AREAS[c.area] : 10) * 100 + ORDER.indexOf(id);
}

const fillIn = (template, word) =>
  template
    .replace('{X}', word ? word.charAt(0).toUpperCase() + word.slice(1) : '')
    .replace('{x}', word ?? '');

/**
 * The line to show and to say for a check, in the creator's language.
 * Hinglish shows Roman script and is spoken from Devanagari (`hs`), which
 * Indian voices read naturally.
 */
export function lineFor(id, language, fill = null, which = 'tip') {
  const c = CHECKS[id];
  const src = which === 'praise' ? (id === 'ALL' ? ALL_PASS : c?.praise) : c;
  if (!src) return null;
  if (language === 'English') {
    const text = fillIn(src.en, fill?.en);
    return { text, spoken: text, languageCode: 'en-IN' };
  }
  if (language === 'Hindi') {
    const text = fillIn(src.hi, fill?.hi);
    return { text, spoken: text, languageCode: 'hi-IN' };
  }
  return {
    text: fillIn(src.hinglish, fill?.hinglish),
    spoken: fillIn(src.hs ?? src.hi, fill?.hs ?? fill?.hi),
    languageCode: 'hi-IN',
  };
}
