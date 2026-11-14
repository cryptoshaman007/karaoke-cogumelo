// Sugestões por categoria no fim da tela do cantor. Lista fixa, escolhida a dedo: tocar numa
// música só preenche a busca (com "karaoke" no fim, pelo servidor), então não depende de vídeo
// específico do YouTube que pode sair do ar.

export interface SuggestedSong {
  title: string;
  artist: string;
}

export interface SuggestionCategory {
  key: string;
  emoji: string;
  name: string;
  blurb: string;
  songs: SuggestedSong[];
}

export const SUGGESTIONS: SuggestionCategory[] = [
  {
    key: 'brasil',
    emoji: '🇧🇷',
    name: 'Mais cantadas no Brasil',
    blurb: 'Clássico de karaokê, o bar inteiro canta junto',
    songs: [
      { title: 'Evidências', artist: 'Chitãozinho & Xororó' },
      { title: 'Garçom', artist: 'Reginaldo Rossi' },
      { title: 'Eu Sei Que Vou Te Amar', artist: 'Tom Jobim' },
      { title: 'Fogo e Paixão', artist: 'Wando' },
      { title: 'Sozinho', artist: 'Caetano Veloso' },
      { title: 'Pense em Mim', artist: 'Leandro & Leonardo' },
    ],
  },
  {
    key: 'sertanejo',
    emoji: '🤠',
    name: 'Sertanejo',
    blurb: 'Do raiz ao universitário',
    songs: [
      { title: 'Cuida Bem Dela', artist: 'Henrique & Juliano' },
      { title: 'Infiel', artist: 'Marília Mendonça' },
      { title: 'Amo Noite e Dia', artist: 'Jorge & Mateus' },
      { title: 'Ai Se Eu Te Pego', artist: 'Michel Teló' },
      { title: 'Fio de Cabelo', artist: 'Chitãozinho & Xororó' },
      { title: 'Saudade da Minha Terra', artist: 'Belmonte & Amaraí' },
    ],
  },
  {
    key: 'sofrencia',
    emoji: '💔',
    name: 'Sofrência',
    blurb: 'Pra cantar de olho fechado e copo na mão',
    songs: [
      { title: 'Supera', artist: 'Marília Mendonça' },
      { title: 'Ciumeira', artist: 'Marília Mendonça' },
      { title: 'Atrasadinha', artist: 'Felipe Araújo' },
      { title: 'Te Esperando', artist: 'Luan Santana' },
      { title: 'Estrelinha', artist: 'Marília Mendonça' },
      { title: 'Graveto', artist: 'Marília Mendonça' },
    ],
  },
  {
    key: 'rock-br',
    emoji: '🎸',
    name: 'Rock nacional',
    blurb: 'Anos 80 e 90 que todo mundo sabe a letra',
    songs: [
      { title: 'Tempo Perdido', artist: 'Legião Urbana' },
      { title: 'Pro Dia Nascer Feliz', artist: 'Barão Vermelho' },
      { title: 'Lanterna dos Afogados', artist: 'Os Paralamas do Sucesso' },
      { title: 'Exagerado', artist: 'Cazuza' },
      { title: 'Primeiros Erros', artist: 'Capital Inicial' },
      { title: 'Anna Júlia', artist: 'Los Hermanos' },
    ],
  },
  {
    key: 'rock',
    emoji: '🤘',
    name: 'Rock gringo',
    blurb: 'Pra soltar o grito',
    songs: [
      { title: 'Bohemian Rhapsody', artist: 'Queen' },
      { title: "Sweet Child O' Mine", artist: "Guns N' Roses" },
      { title: 'Livin on a Prayer', artist: 'Bon Jovi' },
      { title: 'Highway to Hell', artist: 'AC/DC' },
      { title: 'Zombie', artist: 'The Cranberries' },
      { title: 'Wonderwall', artist: 'Oasis' },
    ],
  },
  {
    key: 'pagode',
    emoji: '🥁',
    name: 'Pagode e samba',
    blurb: 'Roda de pagode no microfone',
    songs: [
      { title: 'Deixa Acontecer', artist: 'Grupo Revelação' },
      { title: 'Cheia de Manias', artist: 'Raça Negra' },
      { title: 'Que Se Chama Amor', artist: 'Só Pra Contrariar' },
      { title: 'Assim Você Mata o Papai', artist: 'Sorriso Maroto' },
      { title: 'Tá Escrito', artist: 'Grupo Revelação' },
      { title: 'O Show Tem Que Continuar', artist: 'Fundo de Quintal' },
    ],
  },
  {
    key: 'mpb',
    emoji: '🌻',
    name: 'MPB',
    blurb: 'Voz bonita, clima de barzinho',
    songs: [
      { title: 'Velha Infância', artist: 'Tribalistas' },
      { title: 'Como Nossos Pais', artist: 'Elis Regina' },
      { title: 'Ainda Bem', artist: 'Marisa Monte' },
      { title: 'Trem-Bala', artist: 'Ana Vilela' },
      { title: 'Oceano', artist: 'Djavan' },
      { title: 'Garota de Ipanema', artist: 'Tom Jobim' },
    ],
  },
  {
    key: 'pop',
    emoji: '🪩',
    name: 'Pop pra dançar',
    blurb: 'Hit que levanta o bar',
    songs: [
      { title: 'Dancing Queen', artist: 'ABBA' },
      { title: 'I Will Survive', artist: 'Gloria Gaynor' },
      { title: 'Shallow', artist: 'Lady Gaga & Bradley Cooper' },
      { title: 'Show das Poderosas', artist: 'Anitta' },
      { title: 'Girls Just Want to Have Fun', artist: 'Cyndi Lauper' },
      { title: 'Bad Romance', artist: 'Lady Gaga' },
    ],
  },
];
